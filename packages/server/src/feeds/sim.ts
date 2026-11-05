// Training simulator: flies scenario aircraft along their routes and generates the HF
// radio calls a controller would receive (OCM §8 phraseology), which the controller then
// copies onto the strips.
import fs from 'node:fs';
import {
  expandRoute,
  formatHHMM,
  machToTasKt,
  type Command,
  type RoutePoint,
} from '@oceanic/core';
import type { Store } from '../store.ts';

export interface ScenarioFlight {
  callsign: string;
  aircraft: string;
  adep: string;
  ades: string;
  altn?: string;
  route: string;
  level: number;
  tas: number;
  mach?: number;
  remarks?: string;
  squawk?: string;
  /** place the aircraft so that it reaches `fix` this many minutes after spawning */
  start: { fix: string; minutesBefore: number };
  spawnAfterMin?: number;
  /** pilot estimate error in minutes (adds realism to reported estimates) */
  estimateErrorMin?: number;
  /** skip position reports (simulates a missed report) */
  silentAfterFix?: string;
}

export interface Scenario {
  name: string;
  description?: string;
  startUtc?: string | null;
  timeScale?: number;
  flights: ScenarioFlight[];
}

interface SimAc {
  def: ScenarioFlight;
  route: RoutePoint[];
  s: number; // along-route distance NM
  altFt: number;
  targetFt: number;
  mach?: number;
  spawned: boolean;
  spawnAt: number;
  nextIdx: number;
  contacted: Set<string>;
  reportReaching: boolean;
  silent: boolean;
  done: boolean;
}

const MIN = 60_000;

export class Simulator {
  private acs: SimAc[] = [];
  private timer?: NodeJS.Timeout;
  private last = 0;
  private seq = 0;
  scenario?: Scenario;

  constructor(private store: Store, private autoReports: boolean) {
    store.on('pilotInstruction', (cs: string, cmd: Command) => this.onInstruction(cs, cmd));
  }

  load(file: string, timeScaleOverride?: number) {
    const sc: Scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.scenario = sc;
    const start = sc.startUtc ? Date.parse(sc.startUtc) : Date.now();
    this.store.clock.reset(start, timeScaleOverride ?? sc.timeScale ?? 1);
    const now = this.store.clock.now();
    this.acs = sc.flights.map((def) => {
      const route = expandRoute(def.route, def.adep, def.ades, this.store.navIndex.nav).points;
      const fix = route.find((p) => p.name === def.start.fix) ?? route[1] ?? route[0];
      const tas = def.mach ? machToTasKt(def.mach, def.level) : def.tas;
      const s = Math.max(0, fix.distNm - (tas * def.start.minutesBefore) / 60);
      const nextIdx = Math.max(1, route.findIndex((p) => p.distNm > s));
      return {
        def, route, s,
        altFt: def.level * 100, targetFt: def.level * 100,
        mach: def.mach,
        spawned: false,
        spawnAt: now + (def.spawnAfterMin ?? 0) * MIN,
        nextIdx,
        contacted: new Set(),
        reportReaching: false,
        silent: false,
        done: false,
      };
    });
    this.last = now;
  }

  start() {
    this.timer = setInterval(() => this.step(), 1000);
    this.step();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private tas(ac: SimAc) {
    return ac.mach ? machToTasKt(ac.mach, ac.altFt / 100) : ac.def.tas;
  }

  private posAt(ac: SimAc) {
    const r = ac.route;
    for (let i = 1; i < r.length; i++) {
      if (ac.s <= r[i].distNm) {
        const a = r[i - 1], b = r[i];
        const f = (ac.s - a.distNm) / Math.max(1e-6, b.distNm - a.distNm);
        return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, hdg: 0 };
      }
    }
    const l = r[r.length - 1];
    return { lat: l.lat, lon: l.lon, hdg: 0 };
  }

  private radio(ac: SimAc, unit: string, kind: Parameters<Store['addRadio']>[0]['kind'], text: string, report?: Parameters<Store['addRadio']>[0]['report']) {
    this.store.addRadio({ id: `r${++this.seq}`, at: this.store.clock.now(), unit, callsign: ac.def.callsign, kind, text, report });
  }

  private onInstruction(cs: string, cmd: Command) {
    const ac = this.acs.find((a) => a.def.callsign === cs);
    if (!ac) return;
    if (cmd.type === 'clear_level') {
      ac.targetFt = cmd.level * 100;
      ac.reportReaching = cmd.reportReaching ?? true;
      if (cmd.mach) ac.mach = cmd.mach;
    }
    if (cmd.type === 'set_mach') ac.mach = cmd.mach;
  }

  private step() {
    const now = this.store.clock.now();
    const dtH = Math.max(0, now - this.last) / 3_600_000;
    this.last = now;
    for (const ac of this.acs) {
      if (ac.done) continue;
      if (!ac.spawned) {
        if (now < ac.spawnAt) continue;
        ac.spawned = true;
      }
      // vertical
      if (ac.altFt !== ac.targetFt) {
        const step = 1500 * 60 * dtH;
        ac.altFt = ac.altFt < ac.targetFt ? Math.min(ac.targetFt, ac.altFt + step) : Math.max(ac.targetFt, ac.altFt - step);
        if (ac.altFt === ac.targetFt && ac.reportReaching) {
          ac.reportReaching = false;
          const f = this.store.flights.get(ac.def.callsign);
          const unit = f ? Object.values(f.units).find((u) => u.phase === 'ACTIVE')?.unit : undefined;
          if (unit) this.radio(ac, unit, 'REACHING', `${ac.def.callsign}, reaching FL${Math.round(ac.altFt / 100)}`);
        }
      }
      const gs = this.tas(ac);
      ac.s += gs * dtH;
      // passed points
      while (ac.nextIdx < ac.route.length && ac.s >= ac.route[ac.nextIdx].distNm) {
        this.passed(ac, ac.nextIdx, now, gs);
        ac.nextIdx++;
      }
      if (ac.nextIdx >= ac.route.length) { ac.done = true; continue; }
      this.maybeFirstContact(ac, now);
      const p = this.posAt(ac);
      const d = ac.def;
      this.store.upsert(
        { callsign: d.callsign, aircraft: d.aircraft, adep: d.adep, ades: d.ades, altn: d.altn, route: d.route, cruiseLevel: d.level, tas: d.tas, remarks: d.remarks ?? '', squawk: d.squawk },
        { lat: p.lat, lon: p.lon, altitudeFt: ac.altFt, groundSpeedKt: gs, time: now },
        'SIM',
      );
    }
  }

  private unitsWithStrips(ac: SimAc) {
    const f = this.store.flights.get(ac.def.callsign);
    return f ? Object.values(f.units) : [];
  }

  private maybeFirstContact(ac: SimAc, now: number) {
    const f = this.store.flights.get(ac.def.callsign);
    if (!f || f.category !== 'ADSB') return;
    for (const us of this.unitsWithStrips(ac)) {
      if (ac.contacted.has(us.unit) || us.phase === 'HANDED_OFF') continue;
      const entry = ac.route.find((p) => p.name === us.entryFix);
      if (!entry) continue;
      const minsToEntry = ((entry.distNm - ac.s) / this.tas(ac)) * 60;
      if (minsToEntry <= 2) {
        ac.contacted.add(us.unit);
        const radio = this.store.unit(us.unit)?.radioName ?? us.unit;
        this.radio(ac, us.unit, 'FIRST_CONTACT', `${radio}, ${radio}, ${ac.def.callsign}, FL${Math.round(ac.altFt / 100)}${ac.mach ? `, Mach decimal ${Math.round(ac.mach * 100)}` : ''}`);
      }
    }
  }

  private passed(ac: SimAc, idx: number, now: number, gs: number) {
    if (!this.autoReports) return;
    const f = this.store.flights.get(ac.def.callsign);
    if (!f || f.category !== 'OTHER') return;
    const p = ac.route[idx];
    if (ac.def.silentAfterFix && ac.silent) return;
    for (const us of this.unitsWithStrips(ac)) {
      if (us.phase === 'HANDED_OFF') continue;
      const inUnit = us.pointIndices.some((i) => f.route[i]?.name === p.name);
      if (!inUnit) continue;
      const next = ac.route[idx + 1];
      const then = ac.route[idx + 2];
      const err = (ac.def.estimateErrorMin ?? 0) * (Math.random() * 2 - 1);
      const nextTime = next ? now + ((next.distNm - p.distNm) / gs) * 60 * MIN + err * MIN : undefined;
      const lvl = Math.round(ac.altFt / 100);
      const mach = ac.mach ?? Math.round((gs / 573) * 100) / 100;
      const radio = this.store.unit(us.unit)?.radioName ?? us.unit;
      const first = !ac.contacted.has(us.unit);
      ac.contacted.add(us.unit);
      const sel = f.selcal ? `, SELCAL ${f.selcal.slice(0, 2)}-${f.selcal.slice(2)}` : '';
      const text =
        (first ? `${radio}, ${radio}, ${ac.def.callsign}, with position. ` : '') +
        `${ac.def.callsign} position ${p.name} ${formatHHMM(now)} Zulu, FL${lvl}` +
        (next ? `. Estimating ${next.name} at ${formatHHMM(nextTime)} Zulu` : '') +
        (then ? `, ${then.name} thereafter` : '') +
        `. Mach decimal ${Math.round(mach * 100)}${first ? sel : ''}`;
      this.radio(ac, us.unit, first ? 'FIRST_CONTACT' : 'POSITION', text, {
        fix: p.name,
        time: now,
        level: lvl,
        mach,
        nextFix: next?.isAirport ? undefined : next?.name,
        nextTime: next?.isAirport ? undefined : nextTime,
        thenFix: then?.isAirport ? undefined : then?.name,
      });
      if (ac.def.silentAfterFix === p.name) ac.silent = true;
    }
  }

  status() {
    return {
      scenario: this.scenario?.name,
      description: this.scenario?.description,
      aircraft: this.acs.filter((a) => a.spawned && !a.done).length,
      scale: this.store.clock.rate,
    };
  }
}
