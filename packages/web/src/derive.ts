// Derives the strip board for one unit from flights + conflicts.
import { buildFixStrips, computeTrajectory, indianRouteExcerpt, type FixStrip, type Flight, type TimedPoint, type TrajectoryOptions, type UnitAirspace } from '@oceanic/core';
import type { BoardConflict, UnitConfig } from './state.ts';

const MIN = 60_000;

const trajCache = new WeakMap<Flight, { at: number; traj: TimedPoint[] }>();
export function trajectoryOf(f: Flight, now: number, opts: TrajectoryOptions = { liveGroundSpeed: true }): TimedPoint[] {
  const c = trajCache.get(f);
  if (c && Math.abs(now - c.at) < 10_000) return c.traj;
  const traj = computeTrajectory(f, now, opts);
  trajCache.set(f, { at: now, traj });
  return traj;
}

const excerptCache = new WeakMap<Flight, { text: string; trimmed: boolean }>();
/** Route text for the strip: only the part through Indian oceanic airspace. */
export function routeExcerptOf(f: Flight, airspaces: UnitAirspace[]): { text: string; trimmed: boolean } {
  let c = excerptCache.get(f);
  if (!c) {
    c = indianRouteExcerpt(f.fpl.route, f.route, airspaces);
    excerptCache.set(f, c);
  }
  return c;
}

export interface Bay {
  fix: string;
  airway: string;
  lat: number;
  lon: number;
  strips: FixStrip[];
}

export interface BoardColumn {
  airway: string;
  bays: Bay[];
}

export interface PendingSet {
  flight: Flight;
  strips: FixStrip[];
}

export interface Board {
  pending: PendingSet[];
  columns: BoardColumn[];
  coordination: { flight: Flight; strip: FixStrip }[];
  done: Flight[];
  stripCount: number;
}

export function buildBoard(flights: Map<string, Flight>, unit: UnitConfig, now: number, overdueMin: number): Board {
  const pending: PendingSet[] = [];
  const coordination: Board['coordination'] = [];
  const done: Flight[] = [];
  const bays = new Map<string, Bay>();
  let stripCount = 0;

  for (const f of flights.values()) {
    const us = f.units[unit.id];
    if (!us) continue;
    const traj = trajectoryOf(f, now);
    const strips = buildFixStrips(f, traj, us, now, overdueMin);
    if (us.phase === 'PENDING') { pending.push({ flight: f, strips }); stripCount += strips.length; continue; }
    if (us.phase === 'HANDED_OFF') { done.push(f); continue; }
    const exit = strips[strips.length - 1];
    const needsCoord = exit && !us.estimateOut && exit.eto !== undefined && exit.eto - now <= unit.coordLeadMin * MIN && exit.state !== 'PASSED';
    for (const s of strips) {
      if (s.state === 'PASSED') {
        const passedAt = s.ato ?? s.eto ?? now;
        if (now - passedAt > unit.passedRetentionMin * MIN) continue;
      }
      if (needsCoord && s === exit) {
        coordination.push({ flight: f, strip: s });
        stripCount++;
        continue;
      }
      const p = f.route[s.index];
      let bay = bays.get(s.fix);
      if (!bay) {
        bay = { fix: s.fix, airway: s.airway ?? 'DCT', lat: p.lat, lon: p.lon, strips: [] };
        bays.set(s.fix, bay);
      }
      bay.strips.push(s);
      stripCount++;
    }
  }

  // group bays into route columns by the most common airway of their strips
  const cols = new Map<string, Bay[]>();
  for (const b of bays.values()) {
    const counts = new Map<string, number>();
    for (const s of b.strips) counts.set(s.airway ?? 'DCT', (counts.get(s.airway ?? 'DCT') ?? 0) + 1);
    b.airway = [...counts.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? 'DCT';
    b.strips.sort((a, c) => (a.eto ?? Infinity) - (c.eto ?? Infinity));
    const list = cols.get(b.airway) ?? [];
    list.push(b);
    cols.set(b.airway, list);
  }
  const columns: BoardColumn[] = [...cols.entries()]
    .map(([airway, list]) => {
      // order bays along the route: by the order flights meet them (earliest eto index)
      list.sort((a, c) => {
        const ia = Math.min(...a.strips.map((s) => s.stripNo));
        const ic = Math.min(...c.strips.map((s) => s.stripNo));
        return ia - ic || a.lon - c.lon;
      });
      return { airway, bays: list };
    })
    // stable order so airways do not jump around as traffic changes: alphabetical, DCT last
    .sort((a, c) => (a.airway === 'DCT' ? 1 : 0) - (c.airway === 'DCT' ? 1 : 0) || a.airway.localeCompare(c.airway, undefined, { numeric: true }));

  pending.sort((a, c) => (a.strips[0]?.eto ?? Infinity) - (c.strips[0]?.eto ?? Infinity));
  coordination.sort((a, c) => (a.strip.eto ?? 0) - (c.strip.eto ?? 0));
  return { pending, columns, coordination, done, stripCount };
}

export interface StripHighlight {
  severity: 'LOS' | 'WARN' | 'UNVERIFIED';
  conflicts: BoardConflict[];
  direct: boolean;
}

/** Highlight for a strip: direct if its fix is part of the conflict geometry. */
export function highlightFor(conflicts: BoardConflict[], callsign: string, fix: string): StripHighlight | undefined {
  const mine = conflicts.filter((c) => c.a === callsign || c.b === callsign);
  if (!mine.length) return undefined;
  const direct = mine.filter((c) => c.fixes[callsign]?.includes(fix));
  const list = direct.length ? direct : mine;
  const rank = { LOS: 3, WARN: 2, UNVERIFIED: 1 } as const;
  const worst = list.reduce((w, c) => (rank[c.severity] > rank[w.severity] ? c : w), list[0]);
  return { severity: worst.severity, conflicts: list, direct: direct.length > 0 };
}

export function fmtTime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '----';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** As written by hand on the photo strips: minutes only when the hour is unchanged. */
export function penTime(newMs: number, oldMs?: number): string {
  const n = fmtTime(newMs);
  if (oldMs === undefined) return n;
  const o = fmtTime(oldMs);
  return o.slice(0, 2) === n.slice(0, 2) ? n.slice(2) : n;
}

/** SELCAL as written on strips: DQCM -> DQ-CM */
export function fmtSelcal(s?: string): string {
  const c = (s ?? '').replace(/[^A-Z]/gi, '').toUpperCase();
  return c.length === 4 ? `${c.slice(0, 2)}-${c.slice(2)}` : c;
}

export function machText(m?: number) {
  return m === undefined ? '' : `M.${String(Math.round(m * 100)).padStart(2, '0')}`;
}
