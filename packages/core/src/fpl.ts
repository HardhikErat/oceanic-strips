// ICAO flight plan parsing and Item 15 route expansion.
import { distanceNm, parseIcaoLatLon, type LatLon } from './geo.ts';
import type { Category, RoutePoint, SpeedSpec } from './model.ts';

export interface AirwayNode extends LatLon {
  next: string[];
}

export interface NavData {
  /** fix name -> candidate positions (names are not globally unique) */
  fixes: Record<string, LatLon[]>;
  /** airway -> fix -> node */
  airways: Record<string, Record<string, AirwayNode>>;
  airports: Record<string, LatLon>;
  /** ICAO type -> engine type letter (J/T/P) */
  aircraftEngines?: Record<string, string>;
}

/** Parse the VATSIM/ICAO aircraft field "B77W/H-SDE1E2E3FGHIJ2/LB1D1". */
export function parseAircraftField(s: string): {
  type: string;
  wake: string;
  equipment: string;
  surveillance: string;
} {
  const out = { type: '', wake: '', equipment: '', surveillance: '' };
  if (!s) return out;
  const [left, right = ''] = s.toUpperCase().split('-', 2);
  const lp = left.split('/');
  // FAA style "H/B77W/L" or ICAO "B77W/H"
  if (lp.length === 3) {
    out.wake = lp[0];
    out.type = lp[1];
  } else {
    out.type = lp[0] ?? '';
    out.wake = lp[1] ?? '';
  }
  const [eq = '', surv = ''] = right.split('/');
  out.equipment = eq;
  out.surveillance = surv;
  return out;
}

/** Item 18 indicators: "PBN/A1B1C1D1L1 DOF/261105 SEL/DQCM RMK/TCAS". */
export function parseItem18(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  const re = /\b([A-Z]{3,4})\/(.*?)(?=\s+[A-Z]{3,4}\/|$)/g;
  let m: RegExpExecArray | null;
  const up = s.toUpperCase().replace(/\s+/g, ' ');
  while ((m = re.exec(up))) {
    if (!(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * OCM §3: ADS-B equipped aircraft vs other aircraft. Detected from Item 10b surveillance
 * codes (B1/B2 = ADS-B 1090ES out); the controller can override per strip.
 */
export function classifyCategory(surveillance: string, adsbCodes: string[]): Category {
  const s = (surveillance || '').toUpperCase();
  return adsbCodes.some((c) => s.includes(c)) ? 'ADSB' : 'OTHER';
}

/**
 * Item 8b type of flight is not part of a VATSIM flight plan. Use STS/ or TYP/ hints,
 * otherwise "S" for airline-style callsigns (3 letters + digit) and "G" for the rest.
 */
export function typeOfFlight(callsign: string, item18: Record<string, string>): string {
  const rmk = item18['RMK'] ?? '';
  const m = /TYPE?\s*OF\s*FLIGHT\s*([SNGMX])\b/.exec(rmk);
  if (m) return m[1];
  if (item18['STS']?.includes('STATE')) return 'M';
  return /^[A-Z]{3}\d/.test(callsign) ? 'S' : 'G';
}

export function parseSpeedLevel(tok: string): { speed?: SpeedSpec; levelFl?: number } | null {
  const m = /^(M\d{3}|N\d{4}|K\d{4})(F\d{3}|A\d{3}|S\d{4}|M\d{4}|VFR)?$/.exec(tok);
  if (!m) return null;
  const out: { speed?: SpeedSpec; levelFl?: number } = {};
  const sp = m[1];
  if (sp[0] === 'M') out.speed = { kind: 'M', value: Number(sp.slice(1)) / 100 };
  else if (sp[0] === 'N') out.speed = { kind: 'N', value: Number(sp.slice(1)) };
  else out.speed = { kind: 'K', value: Number(sp.slice(1)) };
  const lv = m[2];
  if (lv) {
    if (lv[0] === 'F' || lv[0] === 'A') out.levelFl = Number(lv.slice(1));
    else if (lv[0] === 'S') out.levelFl = Math.round((Number(lv.slice(1)) * 10 * 3.28084) / 100);
    else if (lv[0] === 'M') out.levelFl = Math.round((Number(lv.slice(1)) * 10 * 3.28084) / 100);
  }
  return out;
}

export function lookupFix(nav: NavData, name: string, near?: LatLon): LatLon | null {
  const cands = nav.fixes[name];
  if (cands && cands.length) {
    if (!near || cands.length === 1) return cands[0];
    let best = cands[0];
    let bd = Infinity;
    for (const c of cands) {
      const d = distanceNm(c, near);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  const ap = nav.airports[name];
  if (ap) return ap;
  return null;
}

/** Breadth-first path along an airway graph between two fixes (inclusive of `to`, exclusive of `from`). */
export function airwayPath(nav: NavData, airway: string, from: string, to: string): string[] | null {
  const g = nav.airways[airway];
  if (!g || !g[from] || !g[to]) return null;
  const prev = new Map<string, string>();
  const q = [from];
  const seen = new Set([from]);
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) break;
    for (const n of g[cur]?.next ?? []) {
      if (!seen.has(n) && g[n]) {
        seen.add(n);
        prev.set(n, cur);
        q.push(n);
      }
    }
  }
  if (!seen.has(to)) return null;
  const path: string[] = [];
  for (let c = to; c !== from; c = prev.get(c)!) path.unshift(c);
  return path;
}

const PROCEDURE_RE = /^[A-Z]{2,5}\d[A-Z]?$/;

export interface ExpandedRoute {
  points: RoutePoint[];
  unresolved: string[];
}

/** Expand an Item 15 route string into geographic points. */
export function expandRoute(route: string, adep: string, ades: string, nav: NavData): ExpandedRoute {
  const tokens = (route || '').toUpperCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const pts: Omit<RoutePoint, 'distNm'>[] = [];
  const unresolved: string[] = [];
  const dep = nav.airports[adep];
  const arr = nav.airports[ades];
  if (dep) pts.push({ name: adep, lat: dep.lat, lon: dep.lon, isAirport: true });

  let pendingAirway: string | null = null;
  let pendingSpeed: { speed?: SpeedSpec; levelFl?: number } | null = null;

  const last = () => pts[pts.length - 1];

  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok === 'DCT' || tok === 'IFR' || tok === 'VFR') { pendingAirway = null; continue; }
    if (tok === adep || tok === ades) continue;
    // initial speed/level group
    // "M300" is both a valid Mach group and an ATS route designator: known airways win
    const sl0 = nav.airways[tok] ? null : parseSpeedLevel(tok);
    if (sl0) { pendingSpeed = sl0; continue; }

    let change: { speed?: SpeedSpec; levelFl?: number } | null = null;
    if (tok.includes('/')) {
      const [a, b] = tok.split('/', 2);
      change = parseSpeedLevel(b);
      tok = a;
    }

    // airway?
    if (nav.airways[tok] && !nav.fixes[tok] && i + 1 < tokens.length) {
      pendingAirway = tok;
      continue;
    }
    if (nav.airways[tok] && last() && nav.airways[tok][last().name] && i + 1 < tokens.length) {
      pendingAirway = tok;
      continue;
    }

    const coord = parseIcaoLatLon(tok);
    let pos: LatLon | null = coord;
    if (!pos) pos = lookupFix(nav, tok, last() ?? dep);
    if (!pos) {
      if (PROCEDURE_RE.test(tok) && !nav.fixes[tok]) { pendingAirway = null; continue; }
      unresolved.push(tok);
      pendingAirway = null;
      continue;
    }

    if (pendingAirway && last()) {
      const path = airwayPath(nav, pendingAirway, last().name, tok);
      if (path) {
        for (const name of path.slice(0, -1)) {
          const n = nav.airways[pendingAirway][name];
          pts.push({ name, lat: n.lat, lon: n.lon, airway: pendingAirway });
        }
        const endNode = nav.airways[pendingAirway][tok];
        if (endNode) pos = { lat: endNode.lat, lon: endNode.lon };
      } else {
        unresolved.push(`${pendingAirway}(${last().name}-${tok})`);
      }
    }

    const p: Omit<RoutePoint, 'distNm'> = {
      name: coord ? tok : tok,
      lat: pos.lat,
      lon: pos.lon,
      airway: pendingAirway ?? undefined,
      isCoordinate: !!coord || undefined,
    };
    const sl = change ?? pendingSpeed;
    if (sl) {
      if (sl.speed) p.speed = sl.speed;
      if (sl.levelFl) p.levelFl = sl.levelFl;
    }
    pendingSpeed = null;
    pendingAirway = null;
    pts.push(p);
  }
  if (arr) pts.push({ name: ades, lat: arr.lat, lon: arr.lon, isAirport: true });

  // de-duplicate consecutive identical points
  const clean: Omit<RoutePoint, 'distNm'>[] = [];
  for (const p of pts) {
    const l = clean[clean.length - 1];
    if (l && l.name === p.name && Math.abs(l.lat - p.lat) < 1e-6 && Math.abs(l.lon - p.lon) < 1e-6) continue;
    clean.push(p);
  }
  let d = 0;
  const points: RoutePoint[] = clean.map((p, i) => {
    if (i > 0) d += distanceNm(clean[i - 1], p);
    return { ...p, distNm: d };
  });
  return { points, unresolved };
}

/** Recompute cumulative distances after the point list changed. */
export function withDistances(points: Omit<RoutePoint, 'distNm'>[]): RoutePoint[] {
  let d = 0;
  return points.map((p, i) => {
    if (i > 0) d += distanceNm(points[i - 1], p);
    return { ...p, distNm: d };
  });
}

/** Speed in force at a route index (the last speed group at or before the index). */
export function speedAt(points: RoutePoint[], index: number): SpeedSpec | undefined {
  for (let i = Math.min(index, points.length - 1); i >= 0; i--) if (points[i].speed) return points[i].speed;
  return undefined;
}
