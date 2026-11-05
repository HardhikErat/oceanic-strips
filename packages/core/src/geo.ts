// Geodesy helpers. Distances in nautical miles, angles in degrees.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface XY {
  x: number;
  y: number;
}

export const EARTH_RADIUS_NM = 3440.065;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing a -> b, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Great-circle intermediate point, f in [0,1]. */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  if (f <= 0) return { lat: a.lat, lon: a.lon };
  if (f >= 1) return { lat: b.lat, lon: b.lon };
  const φ1 = toRad(a.lat), λ1 = toRad(a.lon), φ2 = toRad(b.lat), λ2 = toRad(b.lon);
  const δ = distanceNm(a, b) / EARTH_RADIUS_NM;
  if (δ < 1e-12) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: toDeg(Math.atan2(y, x)) };
}

/**
 * Local flat projection (equirectangular, NM) around an origin. Accurate to well under 1%
 * over the few hundred NM a single conflict check spans at Indian Ocean latitudes.
 */
export function project(origin: LatLon, p: LatLon): XY {
  return {
    x: (p.lon - origin.lon) * 60 * Math.cos(toRad(origin.lat)),
    y: (p.lat - origin.lat) * 60,
  };
}

export function unproject(origin: LatLon, p: XY): LatLon {
  return {
    lat: origin.lat + p.y / 60,
    lon: origin.lon + p.x / (60 * Math.cos(toRad(origin.lat))),
  };
}

// ---------- planar segment helpers (in projected NM) ----------

export const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
export const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
export const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
export const len = (a: XY) => Math.hypot(a.x, a.y);
export const lerpXY = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Parameter t (unclamped) of the projection of p on line a->b. */
export function projectParam(p: XY, a: XY, b: XY): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 < 1e-12 ? 0 : dot(sub(p, a), ab) / l2;
}

export function pointSegDistance(p: XY, a: XY, b: XY): number {
  const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
  return len(sub(p, lerpXY(a, b, t)));
}

/** Intersection params (t on a1a2, u on b1b2) of two lines, or null when parallel. */
export function lineIntersection(a1: XY, a2: XY, b1: XY, b2: XY): { t: number; u: number } | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const qp = sub(b1, a1);
  return { t: cross(qp, s) / den, u: cross(qp, r) / den };
}

/** Minimum distance between two segments and the params where it occurs. */
export function segSegClosest(a1: XY, a2: XY, b1: XY, b2: XY): { d: number; t: number; u: number } {
  const ix = lineIntersection(a1, a2, b1, b2);
  if (ix && ix.t >= 0 && ix.t <= 1 && ix.u >= 0 && ix.u <= 1) return { d: 0, t: ix.t, u: ix.u };
  const cands: { d: number; t: number; u: number }[] = [];
  const tryA = (t: number) => {
    const p = lerpXY(a1, a2, t);
    const u = Math.max(0, Math.min(1, projectParam(p, b1, b2)));
    cands.push({ d: len(sub(p, lerpXY(b1, b2, u))), t, u });
  };
  const tryB = (u: number) => {
    const p = lerpXY(b1, b2, u);
    const t = Math.max(0, Math.min(1, projectParam(p, a1, a2)));
    cands.push({ d: len(sub(p, lerpXY(a1, a2, t))), t, u });
  };
  tryA(0); tryA(1); tryB(0); tryB(1);
  cands.sort((x, y) => x.d - y.d);
  return cands[0];
}

// ---------- polygons ----------

export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat)) {
      const x = ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon;
      if (p.lon < x) inside = !inside;
    }
  }
  return inside;
}

/** Distance (NM) from p to the nearest edge of a closed polygon. */
export function distanceToPolygonEdgeNm(p: LatLon, poly: LatLon[]): number {
  let best = Infinity;
  const P = project(p, p);
  for (let i = 0; i < poly.length; i++) {
    const a = project(p, poly[i]);
    const b = project(p, poly[(i + 1) % poly.length]);
    best = Math.min(best, pointSegDistance(P, a, b));
  }
  return best;
}

// ---------- coordinate parsing ----------

/** EuroScope style "N018.55.23.722" / "E068.21.41.044" -> decimal degrees. */
export function parseEsCoord(s: string): number {
  const m = /^([NSEW])(\d{1,3})\.(\d{1,2})\.(\d{1,2}(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return NaN;
  const v = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return m[1] === 'S' || m[1] === 'W' ? -v : v;
}

/**
 * ICAO Item 15 lat/long points: "15N065E", "1530N06500E", "153000N0650000E".
 * Returns null if the token is not a coordinate.
 */
export function parseIcaoLatLon(tok: string): LatLon | null {
  let m = /^(\d{2})([NS])(\d{3})([EW])$/.exec(tok);
  if (m) {
    const lat = Number(m[1]) * (m[2] === 'S' ? -1 : 1);
    const lon = Number(m[3]) * (m[4] === 'W' ? -1 : 1);
    return { lat, lon };
  }
  m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(tok);
  if (m) {
    const lat = (Number(m[1]) + Number(m[2]) / 60) * (m[3] === 'S' ? -1 : 1);
    const lon = (Number(m[4]) + Number(m[5]) / 60) * (m[6] === 'W' ? -1 : 1);
    return { lat, lon };
  }
  m = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/.exec(tok);
  if (m) {
    const lat = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (m[4] === 'S' ? -1 : 1);
    const lon = (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (m[8] === 'W' ? -1 : 1);
    return { lat, lon };
  }
  return null;
}
