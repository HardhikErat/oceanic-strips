// Fix-posting strips: one strip per reporting point inside a unit's oceanic airspace,
// as printed at AAI Mumbai OCC (see PLAN.md §1.1).
import { bearingDeg, distanceToPolygonEdgeNm, pointInPolygon, type LatLon } from './geo.ts';
import type { TimedPoint } from './estimates.ts';
import type { Flight, RoutePoint, StripMarks, UnitState } from './model.ts';

export interface UnitAirspace {
  id: string;
  polygons: LatLon[][];
}

export function inAirspace(p: LatLon, a: UnitAirspace): boolean {
  return a.polygons.some((poly) => pointInPolygon(p, poly));
}

export function nearAirspaceEdge(p: LatLon, a: UnitAirspace, tolNm: number): boolean {
  return a.polygons.some((poly) => distanceToPolygonEdgeNm(p, poly) <= tolNm);
}

/**
 * Route indices that get a strip in this airspace: points inside it, plus a boundary
 * point (TCP) just outside within `tolNm` of the boundary on entry or exit.
 * Airports are excluded.
 */
export function stripIndicesForAirspace(route: RoutePoint[], a: UnitAirspace, tolNm = 3): number[] {
  const inside = route.map((p) => !p.isAirport && inAirspace(p, a));
  const idx = new Set<number>();
  route.forEach((p, i) => {
    if (p.isAirport) return;
    if (inside[i]) idx.add(i);
    else if ((inside[i + 1] || inside[i - 1]) && nearAirspaceEdge(p, a, tolNm)) idx.add(i);
  });
  // A route that crosses the airspace between two outside points: include both boundary-adjacent points
  if (idx.size === 0) {
    for (let i = 1; i < route.length; i++) {
      const a1 = route[i - 1], b1 = route[i];
      if (a1.isAirport || b1.isAirport) continue;
      const mid = { lat: (a1.lat + b1.lat) / 2, lon: (a1.lon + b1.lon) / 2 };
      if (inAirspace(mid, a)) { idx.add(i - 1); idx.add(i); }
    }
  }
  return [...idx].sort((x, y) => x - y);
}

export type StripState = 'LIVE' | 'PASSED';

export interface FixStrip {
  key: string;
  callsign: string;
  unit: string;
  fix: string;
  index: number;
  /** n of total, as on the printed set */
  stripNo: number;
  total: number;
  eto?: number;
  etoSource?: string;
  /** previously printed estimate, kept for the struck-through display */
  printedEto?: number;
  ato?: number;
  prev?: { fix: string; eto?: number; ato?: number };
  next?: { fix: string; eto?: number; ato?: number };
  /** '>' eastbound (track 000–179), '<' westbound */
  direction: '>' | '<';
  airway?: string;
  state: StripState;
  marks: StripMarks;
  isEntry: boolean;
  isExit: boolean;
  overdue: boolean;
}

export function directionAt(route: RoutePoint[], i: number): '>' | '<' {
  const a = route[Math.max(0, i - 1)];
  const b = route[Math.min(route.length - 1, i === 0 ? 1 : i)];
  const brg = a === b ? 90 : bearingDeg(a, b);
  return brg < 180 ? '>' : '<';
}

export function buildFixStrips(f: Flight, traj: TimedPoint[], us: UnitState, now: number, overdueMin: number): FixStrip[] {
  const total = us.pointIndices.length;
  return us.pointIndices.map((ri, n) => {
    const p = traj[ri];
    const prevP = ri > 0 ? traj[ri - 1] : undefined;
    const nextP = ri + 1 < traj.length ? traj[ri + 1] : undefined;
    const printed = us.printedEtos?.[p.name];
    const overdue =
      f.category === 'OTHER' &&
      us.phase === 'ACTIVE' &&
      !!us.contact &&
      p.ato === undefined &&
      p.eto !== undefined &&
      us.nextReportFix === p.name &&
      now > p.eto + overdueMin * 60_000;
    return {
      key: `${f.callsign}:${us.unit}:${ri}`,
      callsign: f.callsign,
      unit: us.unit,
      fix: p.name,
      index: ri,
      stripNo: n + 1,
      total,
      eto: p.eto,
      etoSource: p.source,
      printedEto: printed,
      ato: p.ato,
      prev: prevP && !prevP.isAirport ? { fix: prevP.name, eto: prevP.eto, ato: prevP.ato } : prevP ? { fix: prevP.name } : undefined,
      next: nextP ? { fix: nextP.name, eto: nextP.eto, ato: nextP.ato } : undefined,
      direction: directionAt(f.route, ri),
      airway: p.airway ?? nextP?.airway,
      state: p.passed ? 'PASSED' : 'LIVE',
      marks: us.marks[p.name] ?? {},
      isEntry: n === 0,
      isExit: n === total - 1,
      overdue,
    };
  });
}
