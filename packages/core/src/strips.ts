// Fix-posting strips: one strip per reporting point inside a unit's oceanic airspace,
// as printed at AAI Mumbai OCC (see PLAN.md §1.1).
import { bearingDeg, distanceNm, distanceToPolygonEdgeNm, lineIntersection, pointInPolygon, type LatLon } from './geo.ts';
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
/** ICAO Item 15 style coordinate name, e.g. 0630N09305E (degrees + minutes). */
export function icaoLatLonName(p: LatLon): string {
  const part = (v: number, degDigits: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 60);
    if (m === 60) { d += 1; m = 0; }
    return `${String(d).padStart(degDigits, '0')}${String(m).padStart(2, '0')}${v < 0 ? neg : pos}`;
  };
  return part(p.lat, 2, 'N', 'S') + part(p.lon, 3, 'E', 'W');
}

/**
 * Add a point wherever the route crosses the boundary of an oceanic airspace between two
 * route points. Direct (DCT) legs across the ocean otherwise have no point inside the
 * airspace, so the flight would get no strips, or would look as if it had already left.
 * Lines between a unit's own sectors are ignored (only real in/out changes count).
 */
export function addBoundaryPoints<T extends LatLon & { name: string; airway?: string; isAirport?: boolean; boundary?: boolean }>(
  points: T[],
  airspaces: UnitAirspace[],
): (T | (LatLon & { name: string; airway?: string; isCoordinate: true; boundary: true }))[] {
  const src = points.filter((p) => !p.boundary);
  const out: (T | (LatLon & { name: string; airway?: string; isCoordinate: true; boundary: true }))[] = [];
  src.forEach((b, i) => {
    if (i > 0) {
      const a = src[i - 1];
      const A = { x: a.lon, y: a.lat }, B = { x: b.lon, y: b.lat };
      const at = (t: number): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      const ts: number[] = [];
      for (const air of airspaces) {
        for (const poly of air.polygons) {
          for (let k = 0; k < poly.length; k++) {
            const p1 = poly[k], p2 = poly[(k + 1) % poly.length];
            const ix = lineIntersection(A, B, { x: p1.lon, y: p1.lat }, { x: p2.lon, y: p2.lat });
            if (!ix || ix.t <= 0 || ix.t >= 1 || ix.u < 0 || ix.u > 1) continue;
            const eps = Math.min(0.002, ix.t / 2, (1 - ix.t) / 2);
            if (inAirspace(at(ix.t - eps), air) !== inAirspace(at(ix.t + eps), air)) ts.push(ix.t);
          }
        }
      }
      ts.sort((x, y) => x - y);
      let last: LatLon = a;
      for (const t of ts) {
        const p = at(t);
        // a route point already on (or next to) the boundary covers it
        if (distanceNm(p, a) < 3 || distanceNm(p, b) < 3 || distanceNm(p, last) < 1) continue;
        out.push({ name: icaoLatLonName(p), lat: p.lat, lon: p.lon, airway: b.airway, isCoordinate: true, boundary: true });
        last = p;
      }
    }
    out.push(b);
  });
  return out;
}

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

/**
 * The part of an Item 15 route that runs through Indian oceanic airspace: from the filed
 * fix at or before the first Indian strip point to the filed fix at or after the last one.
 * Anything left out is marked with "…". Falls back to the whole route when the route does
 * not touch any of the given airspaces.
 */
export function indianRouteExcerpt(route: string, points: RoutePoint[], airspaces: UnitAirspace[]): { text: string; trimmed: boolean } {
  const tokens = route.trim().split(/\s+/).filter(Boolean);
  const idx = new Set<number>();
  for (const a of airspaces) for (const i of stripIndicesForAirspace(points, a)) idx.add(i);
  if (!tokens.length || !idx.size) return { text: route, trimmed: false };
  const first = Math.min(...idx);
  const last = Math.max(...idx);

  // match the filed fixes (token before any "/speed-level" part) to route points, in order
  const tokRoute: (number | undefined)[] = [];
  let ri = 0;
  for (const t of tokens) {
    const base = t.split('/')[0];
    let found: number | undefined;
    for (let j = ri; j < points.length; j++) {
      if (!points[j].boundary && points[j].name === base) { found = j; break; }
    }
    tokRoute.push(found);
    if (found !== undefined) ri = found;
  }
  let start = 0;
  let end = tokens.length - 1;
  for (let k = 0; k < tokens.length; k++) if (tokRoute[k] !== undefined && tokRoute[k]! <= first) start = k;
  for (let k = tokens.length - 1; k >= 0; k--) if (tokRoute[k] !== undefined && tokRoute[k]! >= last) end = k;
  if (end < start) return { text: route, trimmed: false };
  const head = start > 0 ? '… ' : '';
  const tail = end < tokens.length - 1 ? ' …' : '';
  return { text: head + tokens.slice(start, end + 1).join(' ') + tail, trimmed: !!(head || tail) };
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
