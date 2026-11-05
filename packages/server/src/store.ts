// Authoritative session state: flights, strips (unit states), conflicts, coordination
// and radio logs. All mutations go through `apply` so they are audited and broadcast.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  amendFlightPlan,
  applyCommand,
  computeTrajectory,
  createFlight,
  formatHHMM,
  inAirspace,
  nearAirspaceEdge,
  normaliseFpl,
  overdueMinutes,
  printUnit as printUnitFor,
  pointInPolygon,
  probe,
  setResolvedRoute,
  stripIndicesForAirspace,
  tickFlight,
  toProbeFlight,
  updateLive,
  expandRoute,
  type Command,
  type Conflict,
  type CoordEntry,
  type DataSource,
  type Flight,
  type FlightContext,
  type LatLon,
  type LivePosition,
  type RadioMessage,
  type RawFlightPlan,
  type TimedPoint,
} from '@oceanic/core';
import type { Clock } from './clock.ts';
import { ROOT, type ServerConfig, type UnitConfig } from './config.ts';
import type { Db } from './db.ts';
import type { NavIndex } from './nav/sectorFiles.ts';

export interface User {
  cid: string;
  name: string;
  unit?: string;
  role?: 'CONTROLLER' | 'COORDINATOR' | 'OBSERVER';
}

export interface TagData {
  next?: string;
  eto?: string;
  cat: string;
  level: number;
  mach?: number;
  conflict?: { severity: string; with: string };
  due?: boolean;
  phase?: string;
}

const MIN = 60_000;
/** after this long without EuroScope data for a flight, the VATSIM feed takes it over again */
export const ES_STALE_MS = 30_000;

export class Store extends EventEmitter {
  flights = new Map<string, Flight>();
  conflicts: Conflict[] = [];
  acks = new Map<string, { by: string; at: number; severity: string }>();
  coord: CoordEntry[] = [];
  radio: RadioMessage[] = [];
  ctx: FlightContext;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private relevanceCache = new Map<string, boolean>();
  private trajCache = new Map<string, TimedPoint[]>();
  /** last cleared level / Mach reported by EuroScope per flight */
  private lastEs = new Map<string, { clearedFl?: number; mach?: number }>();
  /** real time (ms) EuroScope last sent each flight / a position for it */
  private esSeenAt = new Map<string, number>();
  private esPosAt = new Map<string, number>();
  private conflictsKey = '';
  private neighbourByFix: Record<string, string> = {};
  private regionBox: { minLat: number; maxLat: number; minLon: number; maxLon: number };

  constructor(
    public cfg: ServerConfig,
    public navIndex: NavIndex,
    public clock: Clock,
    private db: Db,
  ) {
    super();
    const nbFile = path.join(ROOT, 'config/neighbours.json');
    if (fs.existsSync(nbFile)) this.neighbourByFix = JSON.parse(fs.readFileSync(nbFile, 'utf8')).byFix ?? {};
    const allRaw = navIndex.airspaces.flatMap((a) => a.polygons.flat());
    const all = allRaw.length ? allRaw : [{ lat: -10, lon: 55 }, { lat: 25, lon: 100 }];
    this.regionBox = {
      minLat: Math.min(...all.map((p) => p.lat)) - 12,
      maxLat: Math.max(...all.map((p) => p.lat)) + 12,
      minLon: Math.min(...all.map((p) => p.lon)) - 15,
      maxLon: Math.max(...all.map((p) => p.lon)) + 15,
    };
    this.ctx = {
      nav: navIndex.nav,
      rules: cfg.rules,
      airspaces: navIndex.airspaces,
      printLeadMin: Math.max(...cfg.units.map((u) => u.printLeadMin)),
      trajectoryOptions: { liveForProcedural: cfg.liveForProcedural, liveGroundSpeed: true },
      neighbourAt: (p, exclude) => this.neighbourAt(p, exclude),
      unitName: (u) => this.unit(u)?.radioName ?? u,
    };
  }

  unit(id: string): UnitConfig | undefined {
    return this.cfg.units.find((u) => u.id === id);
  }

  /** Indian units responsible for a point: inside the airspace, or on its boundary (TCPs). */
  unitsAt(p: LatLon): string[] {
    return this.navIndex.airspaces.filter((a) => inAirspace(p, a) || nearAirspaceEdge(p, a, 5)).map((a) => a.id);
  }

  neighbourAt(p: LatLon & { name?: string }, exclude: string): string | undefined {
    for (const a of this.navIndex.airspaces) if (a.id !== exclude && inAirspace(p, a)) return a.id;
    if (p.name && this.neighbourByFix[p.name]) return this.neighbourByFix[p.name];
    const excludeOwner = this.unit(exclude)?.ownerId;
    // prefer area control (CTR) positions, then FSS; never TWR/APP for an oceanic boundary
    let fss: string | undefined;
    for (const s of this.navIndex.sectors) {
      if (s.owners[0] === excludeOwner || !pointInPolygon(p, s.polygon)) continue;
      for (const o of s.owners) {
        const pos = this.navIndex.positionsById[o];
        if (!pos) continue;
        if (/_CTR$/.test(pos.callsign)) return pos.callsign;
        if (/_FSS$/.test(pos.callsign)) fss ??= pos.callsign;
      }
    }
    return fss;
  }

  // ---------- inputs from data sources ----------

  private inRegion(p?: LatLon) {
    const b = this.regionBox;
    return !!p && p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;
  }

  private isRelevant(raw: RawFlightPlan, live?: LatLon): boolean {
    const key = `${raw.callsign}|${raw.adep}|${raw.ades}|${raw.route}`;
    const c = this.relevanceCache.get(key);
    if (c !== undefined) return c;
    const nav = this.navIndex.nav;
    const quick = this.inRegion(live) || this.inRegion(nav.airports[raw.adep]) || this.inRegion(nav.airports[raw.ades]);
    let rel = false;
    if (quick) {
      const r = expandRoute(raw.route, raw.adep, raw.ades, nav);
      rel = this.navIndex.airspaces.some((a) => stripIndicesForAirspace(r.points, a).length > 0);
    }
    this.relevanceCache.set(key, rel);
    if (this.relevanceCache.size > 20000) this.relevanceCache.clear();
    return rel;
  }

  /** Flight plan + position from the VATSIM feed, the simulator or EuroScope. */
  /** EuroScope sent this flight (or, with `position`, a position for it) within ES_STALE_MS. */
  private esFresh(callsign: string, position = false): boolean {
    const t = (position ? this.esPosAt : this.esSeenAt).get(callsign);
    return t !== undefined && Date.now() - t < ES_STALE_MS;
  }

  upsert(raw: RawFlightPlan, live: LivePosition | undefined, source: DataSource, esRoute?: { name: string; lat: number; lon: number }[], esAssigned?: { clearedFl?: number; mach?: number }) {
    const now = this.clock.now();
    if (source === 'ES') {
      this.esSeenAt.set(raw.callsign, Date.now());
      if (live) this.esPosAt.set(raw.callsign, Date.now());
    }
    let f = this.flights.get(raw.callsign);
    if (!f) {
      if (!raw.route || !raw.adep) return;
      if (!esRoute && !this.isRelevant(raw, live)) return;
      const fpl = normaliseFpl(raw, this.navIndex.nav);
      f = createFlight(fpl, this.ctx, now, source);
      if (esRoute && esRoute.length > 1) setResolvedRoute(f, esRoute, this.ctx, now);
      if (!this.navIndex.airspaces.some((a) => stripIndicesForAirspace(f!.route, a).length)) return;
      this.flights.set(f.callsign, f);
      this.removed.delete(f.callsign);
    } else {
      // EuroScope wins over the feed for a flight while a plugin is sending it. Freshness is
      // tracked separately (real time, not the flight's lastSeen, which the feed also
      // refreshes) so that when the plugin stops – disconnect, or the aircraft leaves its
      // visibility range – the feed takes the flight over again after ES_STALE_MS.
      if (source !== 'ES' && this.esFresh(f.callsign)) {
        // flight plan and route stay EuroScope's; the feed position is used only when
        // EuroScope has no correlated target for this flight
        if (live && !this.esFresh(f.callsign, true)) { updateLive(f, live); this.trajCache.delete(f.callsign); }
        return;
      }
      const fpl = normaliseFpl(raw, this.navIndex.nav);
      if (amendFlightPlan(f, fpl, this.ctx, now)) this.markDirty(f.callsign);
      if (esRoute && esRoute.length > 1 && setResolvedRoute(f, esRoute, this.ctx, now)) this.markDirty(f.callsign);
      f.source = source;
    }
    // EuroScope -> board: only take EuroScope's cleared level / Mach when it *changes* in
    // EuroScope. A value EuroScope keeps reporting (because our amendment has not been
    // applied yet, or was refused) must not overwrite what the controller set on the strips.
    if (esAssigned) {
      const last = this.lastEs.get(f.callsign);
      const fl = esAssigned.clearedFl && esAssigned.clearedFl > 50 ? esAssigned.clearedFl : undefined;
      const mach = esAssigned.mach && esAssigned.mach > 0.3 ? Math.round(esAssigned.mach * 100) / 100 : undefined;
      const firstSight = !last;
      if (fl !== undefined && fl !== last?.clearedFl && fl !== f.level.cleared && (!firstSight || f.level.changeStartedAt === undefined)) {
        applyCommand(f, { type: 'clear_level', callsign: f.callsign, unit: Object.keys(f.units)[0] ?? 'VABX', level: fl }, this.ctx, now, 'EuroScope');
        this.markDirty(f.callsign);
      }
      if (mach !== undefined && mach !== last?.mach && Math.abs((f.mach ?? 0) - mach) > 0.004 && (!firstSight || f.mach === undefined)) {
        f.mach = mach;
        this.markDirty(f.callsign);
      }
      this.lastEs.set(f.callsign, { clearedFl: fl, mach });
    }
    if (live) { updateLive(f, live); this.trajCache.delete(f.callsign); }
    else f.lastSeen = now;
  }

  markDirty(cs: string) {
    this.dirty.add(cs);
    this.trajCache.delete(cs);
  }

  traj(f: Flight): TimedPoint[] {
    let t = this.trajCache.get(f.callsign);
    if (!t) {
      t = computeTrajectory(f, this.clock.now(), this.ctx.trajectoryOptions);
      this.trajCache.set(f.callsign, t);
    }
    return t;
  }

  // ---------- controller commands ----------

  apply(cmd: Command, user: User): { ok: boolean; error?: string } {
    const now = this.clock.now();
    if (cmd.type === 'radio_handled') {
      const m = this.radio.find((r) => r.id === cmd.id);
      if (m) { m.handled = true; this.emit('radio', m); }
      return { ok: true };
    }
    const f = this.flights.get(cmd.callsign);
    if (!f) return { ok: false, error: `Unknown flight ${cmd.callsign}` };
    const res = applyCommand(f, cmd, this.ctx, now, user.name || user.cid);
    if (!res.ok) return res;
    this.db.event({ at: Date.now(), sim_at: now, cid: user.cid, name: user.name, unit: cmd.unit, callsign: cmd.callsign, type: cmd.type, payload: JSON.stringify(cmd) });
    for (const c of res.coord ?? []) this.addCoord(c);

    // inter-unit coordination between Indian oceanic units
    if (cmd.type === 'estimate_out' && this.unit(cmd.to) && cmd.to !== cmd.unit) {
      applyCommand(f, { type: 'estimate_in', callsign: f.callsign, unit: cmd.to, fix: cmd.fix, time: cmd.time, from: cmd.unit }, this.ctx, now, user.name);
    }
    if (cmd.type === 'handoff') {
      const target = this.cfg.units.find((u) => u.id === cmd.to || u.esPositions.includes(cmd.to));
      if (target && target.id !== cmd.unit) {
        const r = applyCommand(f, { type: 'activate', callsign: f.callsign, unit: target.id }, this.ctx, now, user.name);
        if (r.ok) f.history.push({ at: now, unit: target.id, kind: 'HANDOFF', text: `Transferred from ${this.unit(cmd.unit)?.radioName}: expect contact` });
      }
    }
    if (res.esAmend) this.emit('esAmend', f.callsign, res.esAmend);
    if (cmd.type === 'clear_level' || cmd.type === 'set_mach') this.emit('pilotInstruction', f.callsign, cmd);
    this.markDirty(f.callsign);
    this.flush();
    return { ok: true };
  }

  /** Probe a proposed clearance without applying it (what-if). */
  whatIf(cmd: Command): { ok: boolean; error?: string; conflicts?: Conflict[]; route?: string[] } {
    if (cmd.type === 'radio_handled') return { ok: false, error: 'n/a' };
    const f = this.flights.get(cmd.callsign);
    if (!f) return { ok: false, error: `Unknown flight ${cmd.callsign}` };
    const now = this.clock.now();
    const clone: Flight = JSON.parse(JSON.stringify(f));
    if (!clone.units[cmd.unit]) printUnitFor(clone, cmd.unit, this.ctx, now);
    const r = applyCommand(clone, cmd, this.ctx, now, 'what-if');
    if (!r.ok) return { ok: false, error: r.error };
    const pfs = [];
    for (const g of this.flights.values()) {
      const x = g.callsign === clone.callsign ? clone : g;
      if (x !== clone && !Object.values(x.units).some((u) => u.phase !== 'HANDED_OFF')) continue;
      pfs.push(toProbeFlight(x, computeTrajectory(x, now, this.ctx.trajectoryOptions), now, this.ctx.rules));
    }
    const conflicts = probe(pfs, {
      rules: this.ctx.rules,
      now,
      unitsAt: (p) => this.unitsAt(p),
    }).filter((c) => c.a === clone.callsign || c.b === clone.callsign);
    return { ok: true, conflicts, route: clone.route.map((p) => p.name) };
  }

  addCoord(c: CoordEntry) {
    this.coord.push(c);
    if (this.coord.length > 500) this.coord.shift();
    this.db.event({ at: Date.now(), sim_at: this.clock.now(), cid: '', name: c.by ?? '', unit: c.from, callsign: c.callsign, type: `coord_${c.kind.toLowerCase()}`, payload: JSON.stringify(c) });
    this.emit('coord', c);
  }

  addRadio(m: RadioMessage) {
    this.radio.push(m);
    if (this.radio.length > 300) this.radio.shift();
    this.emit('radio', m);
  }

  ackConflict(id: string, user: User) {
    const c = this.conflicts.find((x) => x.id === id);
    if (!c) return;
    this.acks.set(id, { by: user.name, at: Date.now(), severity: c.severity });
    this.emit('conflicts', this.conflictsPayload());
  }

  conflictsPayload() {
    return this.conflicts.map((c) => {
      const a = this.acks.get(c.id);
      return { ...c, acknowledged: !!a && a.severity === c.severity ? a.by : undefined };
    });
  }

  // ---------- periodic processing ----------

  tick() {
    const now = this.clock.now();
    for (const f of this.flights.values()) {
      const before = JSON.stringify(Object.keys(f.units)) + Object.keys(f.atos).length;
      const traj = tickFlight(f, this.ctx, now);
      this.trajCache.set(f.callsign, traj);
      const after = JSON.stringify(Object.keys(f.units)) + Object.keys(f.atos).length;
      if (before !== after) this.dirty.add(f.callsign);

      // lost data: keep strips (procedural control does not need a target), remove unprinted ones
      const silentMin = (now - f.lastSeen) / MIN;
      const anyActive = Object.values(f.units).some((u) => u.phase !== 'HANDED_OFF');
      const allDone = Object.values(f.units).length > 0 && !anyActive;
      const lastHandoff = Math.max(0, ...Object.values(f.units).map((u) => u.handoff?.at ?? 0));
      if ((!Object.keys(f.units).length && silentMin > 3) || (allDone && now - lastHandoff > 45 * MIN) || silentMin > 120) {
        this.flights.delete(f.callsign);
        this.lastEs.delete(f.callsign);
        this.esSeenAt.delete(f.callsign);
        this.esPosAt.delete(f.callsign);
        this.removed.add(f.callsign);
        this.trajCache.delete(f.callsign);
      }
    }
    this.runProbe(now);
    this.flush();
  }

  private runProbe(now: number) {
    const pfs = [];
    for (const f of this.flights.values()) {
      if (!Object.values(f.units).some((u) => u.phase !== 'HANDED_OFF')) continue;
      pfs.push(toProbeFlight(f, this.traj(f), now, this.ctx.rules));
    }
    const near = (p: LatLon) => this.navIndex.airspaces.some((a) => inAirspace(p, a) || nearAirspaceEdge(p, a, 80));
    this.conflicts = probe(pfs, {
      rules: this.ctx.rules,
      now,
      unitsAt: (p) => this.unitsAt(p),
      isRelevant: (a, b) => near(a) || near(b) || near({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }),
    });
    const key = JSON.stringify(this.conflicts.map((c) => [c.id, c.severity, c.actualMin, c.actualNm, c.rule.id]));
    if (key !== this.conflictsKey) {
      this.conflictsKey = key;
      this.emit('conflicts', this.conflictsPayload());
    }
  }

  private flush() {
    if (this.dirty.size) {
      const list = [...this.dirty].map((cs) => this.flights.get(cs)).filter(Boolean) as Flight[];
      this.dirty.clear();
      if (list.length) this.emit('flights', list);
    }
    if (this.removed.size) {
      this.emit('removed', [...this.removed]);
      this.removed.clear();
    }
  }

  /** ADS-B aircraft send updates each tick; the board only needs them every few seconds. */
  liveSnapshot() {
    return [...this.flights.values()].filter((f) => f.live).map((f) => ({ callsign: f.callsign, live: f.live, atos: f.atos }));
  }

  tagData(): Record<string, TagData> {
    const out: Record<string, TagData> = {};
    const now = this.clock.now();
    for (const f of this.flights.values()) {
      const traj = this.traj(f);
      const next = traj.find((p) => !p.passed && p.ato === undefined && !p.isAirport);
      const c = this.conflicts.find((x) => x.a === f.callsign || x.b === f.callsign);
      out[f.callsign] = {
        next: next?.name,
        eto: next ? formatHHMM(next.eto) : undefined,
        cat: f.category === 'ADSB' ? 'ADS' : 'PRC',
        level: f.level.cleared,
        mach: f.mach,
        conflict: c ? { severity: c.severity, with: c.a === f.callsign ? c.b : c.a } : undefined,
        due: overdueMinutes(f, traj, now, this.ctx.rules) > 0,
        phase: Object.values(f.units).map((u) => `${u.unit}:${u.phase}`).join(' '),
      };
    }
    return out;
  }

  snapshot() {
    return {
      flights: [...this.flights.values()],
      conflicts: this.conflictsPayload(),
      coord: this.coord.slice(-200),
      radio: this.radio.slice(-150),
    };
  }
}
