// Estimate (ETO) engine. Precedence at each point: ATO > explicit estimate (pilot,
// coordinated, controller) > calculated from the previous point > nothing.
import { machToTasKt } from './atmosphere.ts';
import { speedAt } from './fpl.ts';
import { distanceNm, project, projectParam, lerpXY, len, sub, type LatLon } from './geo.ts';
import type { EstimateSource, Flight, RoutePoint } from './model.ts';

export type EtoSource = EstimateSource | 'CALC';

export interface TimedPoint extends RoutePoint {
  index: number;
  eto?: number;
  source?: EtoSource;
  ato?: number;
  passed: boolean;
}

export interface TrajectoryOptions {
  /** use live position for estimates of procedural (non ADS-B) aircraft before their first report */
  liveForProcedural?: boolean;
  /** use live ground speed for ADS-B aircraft */
  liveGroundSpeed?: boolean;
}

const MIN = 60_000;

/** Ground speed (kt) to use on the segment ending at `index`. */
export function groundSpeedKt(f: Flight, index: number, opts: TrajectoryOptions = {}): number {
  if (opts.liveGroundSpeed && f.category === 'ADSB' && f.live && f.live.groundSpeedKt > 150) {
    return f.live.groundSpeedKt;
  }
  const level = f.level.cleared || f.fpl.rfl || 350;
  if (f.mach) return machToTasKt(f.mach, level);
  const sp = speedAt(f.route, index);
  if (sp) {
    if (sp.kind === 'M') return machToTasKt(sp.value, level);
    if (sp.kind === 'N') return sp.value;
    return sp.value / 1.852;
  }
  return f.fpl.tas > 100 ? f.fpl.tas : 450;
}

/** Locate a live position along the route: index of the next point ahead and distance to it. */
export function locateOnRoute(route: RoutePoint[], pos: LatLon): { nextIndex: number; distToNextNm: number; crossTrackNm: number } | null {
  if (route.length < 2) return null;
  let best: { nextIndex: number; distToNextNm: number; crossTrackNm: number } | null = null;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const origin = a;
    const A = project(origin, a), B = project(origin, b), P = project(origin, pos);
    const t = projectParam(P, A, B);
    const tc = Math.max(0, Math.min(1, t));
    const xt = len(sub(P, lerpXY(A, B, tc)));
    if (t < -0.02 || t > 1.02) {
      // outside the segment; only acceptable at route start
      if (!(i === 1 && t < 0)) continue;
    }
    if (!best || xt < best.crossTrackNm) {
      best = { nextIndex: i, distToNextNm: distanceNm(pos, b), crossTrackNm: xt };
    }
  }
  return best;
}

export function computeTrajectory(f: Flight, now: number, opts: TrajectoryOptions = {}): TimedPoint[] {
  const pts: TimedPoint[] = f.route.map((p, index) => ({ ...p, index, passed: false }));
  if (!pts.length) return pts;

  // last point with an actual time over
  let lastAto = -1;
  pts.forEach((p, i) => {
    const a = f.atos[p.name];
    if (a) {
      p.ato = a.time;
      p.eto = a.time;
      p.source = 'ATO';
      p.passed = true;
      lastAto = i;
    }
  });
  for (let i = 0; i < lastAto; i++) pts[i].passed = true;

  // live anchor
  let liveAnchor: { index: number; time: number } | null = null;
  const useLive = f.live && (f.category === 'ADSB' || opts.liveForProcedural || (lastAto < 0 && !hasExplicitAhead(f, pts, 0)));
  if (useLive && f.live) {
    const loc = locateOnRoute(f.route, f.live);
    if (loc && loc.crossTrackNm < 120) {
      const gs = groundSpeedKt(f, loc.nextIndex, opts);
      liveAnchor = { index: loc.nextIndex, time: now + (loc.distToNextNm / gs) * 60 * MIN };
      if (loc.nextIndex - 1 > lastAto) for (let i = 0; i < loc.nextIndex; i++) pts[i].passed = true;
    }
  }

  let t: number | undefined;
  let src: EtoSource | undefined;
  const startIdx = Math.max(0, lastAto);
  for (let i = startIdx; i < pts.length; i++) {
    const p = pts[i];
    if (p.ato !== undefined) { t = p.ato; src = 'ATO'; continue; }
    const ex = f.estimates[p.name];
    if (ex && i > lastAto) {
      t = ex.time;
      src = ex.source;
    } else if (liveAnchor && i === liveAnchor.index && (liveAnchor.index > lastAto) && (f.category === 'ADSB' || t === undefined || opts.liveForProcedural)) {
      t = liveAnchor.time;
      src = 'SYSTEM';
    } else if (t !== undefined && i > 0) {
      const seg = p.distNm - pts[i - 1].distNm;
      t = t + (seg / groundSpeedKt(f, i, opts)) * 60 * MIN;
      src = src === 'SYSTEM' ? 'SYSTEM' : 'CALC';
    } else {
      continue;
    }
    p.eto = t;
    p.source = src;
  }

  // points before the first known time: back-calculate so prev boxes can show something
  const firstTimed = pts.findIndex((p) => p.eto !== undefined);
  if (firstTimed > 0) {
    for (let i = firstTimed - 1; i >= 0; i--) {
      const seg = pts[i + 1].distNm - pts[i].distNm;
      pts[i].eto = pts[i + 1].eto! - (seg / groundSpeedKt(f, i + 1, opts)) * 60 * MIN;
      pts[i].source = 'CALC';
    }
  }
  return pts;
}

function hasExplicitAhead(f: Flight, pts: TimedPoint[], from: number): boolean {
  for (let i = from; i < pts.length; i++) if (f.estimates[pts[i].name]) return true;
  return false;
}

/** Position along the trajectory at time t (linear between timed points). */
export function positionAt(pts: TimedPoint[], t: number): LatLon | null {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.eto === undefined || b.eto === undefined) continue;
    if (t >= a.eto && t <= b.eto) {
      const f = b.eto === a.eto ? 0 : (t - a.eto) / (b.eto - a.eto);
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  return null;
}

/** Level band [lo, hi] (FL) occupied at time t. */
export function levelBandAt(f: Flight, t: number): [number, number] {
  const L = f.level;
  if (L.block) return [Math.min(...L.block), Math.max(...L.block)];
  if (L.previous !== undefined && L.changeStartedAt !== undefined && !L.confirmed && t >= L.changeStartedAt - MIN) {
    return [Math.min(L.previous, L.cleared), Math.max(L.previous, L.cleared)];
  }
  if (L.previous !== undefined && L.changeStartedAt !== undefined && t < L.changeStartedAt) {
    return [L.previous, L.previous];
  }
  return [L.cleared, L.cleared];
}

export function formatHHMM(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return '----';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Parse "1755" / "1755Z" / "17:55" relative to `now` (nearest day, ±12h). */
export function parseHHMM(s: string, now: number): number | null {
  const m = /^(\d{1,2}):?(\d{2})Z?$/i.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const d = new Date(now);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi);
  let best = base;
  for (const off of [-86400000, 86400000]) {
    if (Math.abs(base + off - now) < Math.abs(best - now)) best = base + off;
  }
  return best;
}
