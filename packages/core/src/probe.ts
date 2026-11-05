// Procedural conflict probe (OCM §6 + LoA). Pairwise over 4D trajectories built from
// strip estimates. Works on the same data the controller has on the strips.
import { levelBandAt, type TimedPoint } from './estimates.ts';
import {
  angleDiff,
  bearingDeg,
  distanceNm,
  lerpXY,
  len,
  project,
  projectParam,
  segSegClosest,
  sub,
  unproject,
  type LatLon,
  type XY,
} from './geo.ts';
import type { Conflict, ConflictKind, ConflictSeverity, Flight, RuleRef } from './model.ts';
import { machTableMinutes, verticalMinFl, type SeparationRules } from './rules.ts';

const MIN = 60_000;

export interface ProbeFlight {
  flight: Flight;
  traj: TimedPoint[];
  /** fixes where this flight enters an Indian oceanic unit */
  entryFixes: LatLon[];
  /** minutes the flight's next report is overdue (0 if not); widens uncertainty */
  uncertaintyMin: number;
}

export interface ProbeContext {
  rules: SeparationRules;
  now: number;
  unitsAt: (p: LatLon) => string[];
  /** limit to segments where this returns true (e.g. near Indian oceanic airspace) */
  isRelevant?: (a: LatLon, b: LatLon) => boolean;
}

interface Seg {
  a: TimedPoint;
  b: TimedPoint;
  brg: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

interface Candidate {
  kind: ConflictKind;
  severity: ConflictSeverity | null;
  margin: number; // actual / required (lower is worse)
  time: number;
  loc: LatLon;
  actualMin?: number;
  actualNm?: number;
  requiredMin?: number;
  requiredNm?: number;
  rule: RuleRef;
  fixesA: string[];
  fixesB: string[];
  note?: string;
}

const SEV_RANK: Record<ConflictSeverity, number> = { LOS: 3, WARN: 2, UNVERIFIED: 1 };

function segments(pf: ProbeFlight, ctx: ProbeContext): Seg[] {
  const out: Seg[] = [];
  const t = pf.traj;
  const lo = ctx.now - 2 * MIN;
  const hi = ctx.now + ctx.rules.horizonMin * MIN;
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1], b = t[i];
    if (a.eto === undefined || b.eto === undefined) continue;
    if (b.eto < lo || a.eto > hi) continue;
    if (b.distNm - a.distNm < 0.01) continue;
    if (ctx.isRelevant && !ctx.isRelevant(a, b)) continue;
    out.push({
      a, b,
      brg: bearingDeg(a, b),
      minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
      minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon),
    });
  }
  return out;
}

function fmtLevel(f: Flight): string {
  const L = f.level;
  if (L.block) return `F${L.block[0]}B${L.block[1]}`;
  if (L.previous !== undefined && !L.confirmed && L.previous !== L.cleared) {
    return `F${L.previous}${L.cleared > L.previous ? '↑' : '↓'}${L.cleared}`;
  }
  return `F${L.cleared}`;
}

/** Vertical separation over [t0, t1]. */
function vertSeparated(A: Flight, B: Flight, t0: number, t1: number, rules: SeparationRules): boolean {
  const times = [t0, t1, (t0 + t1) / 2];
  for (const f of [A, B]) {
    const c = f.level.changeStartedAt;
    if (c !== undefined && c > t0 && c < t1) times.push(c);
  }
  for (const t of times) {
    const [aLo, aHi] = levelBandAt(A, t);
    const [bLo, bHi] = levelBandAt(B, t);
    const gap = Math.max(bLo - aHi, aLo - bHi);
    const min = verticalMinFl(rules, Math.max(aHi, bHi));
    if (gap < min) return false;
  }
  return true;
}

function nearestName(loc: LatLon, ...pts: TimedPoint[]): string | undefined {
  let best: TimedPoint | undefined;
  let bd = Infinity;
  for (const p of pts) {
    const d = distanceNm(loc, p);
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd < 2 && !best.isCoordinate ? best.name : best && bd < 2 ? best.name : undefined;
}

/** Closest point of approach (NM) of two linearly moving points over their common time window. */
function cpaNm(A1: XY, A2: XY, ta0: number, ta1: number, B1: XY, B2: XY, tb0: number, tb1: number): { d: number; t: number } | null {
  const t0 = Math.max(ta0, tb0);
  const t1 = Math.min(ta1, tb1);
  if (t1 < t0) return null;
  const pa = (t: number) => lerpXY(A1, A2, ta1 === ta0 ? 0 : (t - ta0) / (ta1 - ta0));
  const pb = (t: number) => lerpXY(B1, B2, tb1 === tb0 ? 0 : (t - tb0) / (tb1 - tb0));
  const d0 = sub(pa(t0), pb(t0));
  const d1 = sub(pa(t1), pb(t1));
  const dv = sub(d1, d0);
  const l2 = dv.x * dv.x + dv.y * dv.y;
  let s = l2 < 1e-12 ? 0 : -(d0.x * dv.x + d0.y * dv.y) / l2;
  s = Math.max(0, Math.min(1, s));
  const dmin = len({ x: d0.x + dv.x * s, y: d0.y + dv.y * s });
  return { d: dmin, t: t0 + (t1 - t0) * s };
}

function evalPair(A: ProbeFlight, B: ProbeFlight, sa: Seg, sb: Seg, ctx: ProbeContext): Candidate | null {
  const { rules } = ctx;
  const fa = A.flight, fb = B.flight;
  const bothAdsb = fa.category === 'ADSB' && fb.category === 'ADSB';
  const devA = fa.deviation?.nm ?? 0;
  const devB = fb.deviation?.nm ?? 0;
  const lateralMin = (bothAdsb ? rules.lateral.adsbNm : rules.lateral.otherNm) + devA + devB;

  const origin = sa.a;
  const A1 = project(origin, sa.a), A2 = project(origin, sa.b);
  const B1 = project(origin, sb.a), B2 = project(origin, sb.b);
  const close = segSegClosest(A1, A2, B1, B2);
  if (close.d >= lateralMin) return null;

  const ta0 = sa.a.eto!, ta1 = sa.b.eto!, tb0 = sb.a.eto!, tb1 = sb.b.eto!;
  const tA = (u: number) => ta0 + (ta1 - ta0) * u;
  const tB = (u: number) => tb0 + (tb1 - tb0) * u;
  const angle = angleDiff(sa.brg, sb.brg);
  const kind: ConflictKind =
    angle < rules.longitudinal.sameTrackMaxAngle ? 'SAME' : angle > rules.longitudinal.oppositeMinAngle ? 'OPPOSITE' : 'CROSSING';
  const fixesA = [sa.a.name, sa.b.name];
  const fixesB = [sb.a.name, sb.b.name];

  if (kind === 'OPPOSITE') {
    // Solve for the passing time along A's axis.
    const uB1 = projectParam(B1, A1, A2), uB2 = projectParam(B2, A1, A2);
    const dA = ta1 - ta0, dB = tb1 - tb0;
    if (dA <= 0 || dB <= 0) return null;
    // uA(t) = (t - ta0)/dA ; uB(t) = uB1 + (uB2 - uB1)(t - tb0)/dB
    const k1 = 1 / dA, k2 = (uB2 - uB1) / dB;
    const denom = k1 - k2;
    if (Math.abs(denom) < 1e-15) return null;
    const tp = (uB1 - k2 * tb0 + k1 * ta0) / denom;
    if (tp < Math.max(ta0, tb0) - MIN || tp > Math.min(ta1, tb1) + MIN) return null;
    const w = rules.longitudinal.opposite.windowMin * MIN;
    if (vertSeparated(fa, fb, tp - w, tp + w, rules)) return null;
    const loc = unproject(origin, lerpXY(A1, A2, Math.max(0, Math.min(1, (tp - ta0) / dA))));
    const fix = nearestName(loc, sa.a, sa.b, sb.a, sb.b);
    return {
      kind, severity: 'LOS', margin: 0, time: tp,
      loc: fix ? { ...loc } : loc,
      actualMin: Math.round((tp - ctx.now) / MIN),
      requiredMin: rules.longitudinal.opposite.windowMin,
      rule: { id: 'OPPOSITE', text: `Opposite direction at same level – passing ~${Math.max(0, Math.round((tp - ctx.now) / MIN))} min from now`, source: rules.longitudinal.opposite.source },
      fixesA, fixesB,
      note: rules.longitudinal.opposite.note,
    };
  }

  // SAME / CROSSING: find the comparison point(s)
  let uA: number, uB: number, deltaMs: number;
  if (kind === 'SAME') {
    const uB1 = projectParam(B1, A1, A2), uB2 = projectParam(B2, A1, A2);
    const lo = Math.max(0, Math.min(uB1, uB2));
    const hi = Math.min(1, Math.max(uB1, uB2));
    const evalAt = (u: number) => {
      const p = lerpXY(A1, A2, u);
      const ub = Math.max(0, Math.min(1, projectParam(p, B1, B2)));
      return { u, ub, d: tA(u) - tB(ub) };
    };
    let pick;
    if (lo <= hi) {
      const e1 = evalAt(lo), e2 = evalAt(hi);
      if (Math.sign(e1.d) !== Math.sign(e2.d) && e1.d !== 0 && e2.d !== 0) {
        // overtaking inside the common portion
        const f = Math.abs(e1.d) / (Math.abs(e1.d) + Math.abs(e2.d));
        const u = lo + (hi - lo) * f;
        pick = evalAt(u);
        pick.d = 0;
      } else pick = Math.abs(e1.d) <= Math.abs(e2.d) ? e1 : e2;
    } else {
      pick = { u: close.t, ub: close.u, d: tA(close.t) - tB(close.u) };
    }
    uA = pick.u; uB = pick.ub; deltaMs = pick.d;
  } else {
    uA = close.t; uB = close.u; deltaMs = tA(uA) - tB(uB);
  }

  const timeA = tA(uA), timeB = tB(uB);
  // ignore if both have already passed the point
  if (Math.max(timeA, timeB) < ctx.now - MIN) return null;
  const pad = (rules.longitudinal.other.crossingMin + rules.warnBufferMin) * MIN;
  if (vertSeparated(fa, fb, Math.min(timeA, timeB) - pad / 3, Math.max(timeA, timeB) + pad / 3, rules)) return null;

  const loc = unproject(origin, lerpXY(A1, A2, uA));
  const locFix = nearestName(loc, sa.a, sa.b, sb.a, sb.b);
  const actualMin = Math.abs(deltaMs) / MIN;
  const aPreceding = deltaMs < 0;
  const preceding = aPreceding ? fa : fb;
  const following = aPreceding ? fb : fa;

  let requiredMin: number | undefined;
  let requiredNm: number | undefined;
  let actualNm: number | undefined;
  let rule: RuleRef;

  if (bothAdsb) {
    const entries = [...A.entryFixes, ...B.entryFixes];
    const atEntry = entries.some((e) => distanceNm(e, loc) < 5);
    if (atEntry) {
      requiredMin = rules.longitudinal.adsb.entryMin;
      rule = { id: 'ADSB_ENTRY', text: `ADS-B: ${requiredMin} min at entry point`, source: rules.longitudinal.adsb.source };
    } else {
      requiredNm = rules.longitudinal.adsb.thereafterNm;
      const cpa = cpaNm(A1, A2, ta0, ta1, B1, B2, tb0, tb1);
      if (cpa) {
        actualNm = cpa.d;
      } else {
        const fseg = aPreceding ? sb : sa;
        const gs = (fseg.b.distNm - fseg.a.distNm) / ((fseg.b.eto! - fseg.a.eto!) / 3_600_000);
        actualNm = actualMin * (gs / 60);
      }
      rule = { id: 'ADSB_DIST', text: `ADS-B: ${requiredNm} NM after entry`, source: rules.longitudinal.adsb.source };
    }
  } else if (kind === 'SAME') {
    requiredMin = rules.longitudinal.other.sameTrackMin;
    rule = { id: 'SAME_TRACK', text: `Same track: ${requiredMin} min`, source: rules.longitudinal.other.source };
    const mnt = rules.longitudinal.mnt;
    const jetsOk = !mnt.requireTurbojet || (fa.turbojet && fb.turbojet);
    const pm = preceding.mach ?? (mnt.requireAssignedMach ? undefined : undefined);
    const fm = following.mach;
    const loa = rules.loas.find(
      (l) => locFix && l.tcps.includes(locFix) && (Object.keys(fa.units).some((u) => l.units.includes(u)) || Object.keys(fb.units).some((u) => l.units.includes(u))),
    );
    if (jetsOk && pm !== undefined && fm !== undefined) {
      const diff = pm - fm;
      if (loa) {
        requiredMin = machTableMinutes(loa.machTable, diff, loa.sameDirectionMin);
        rule = { id: 'LOA', text: `${loa.name}: ${requiredMin} min (preceding M${pm.toFixed(2)} / following M${fm.toFixed(2)})`, source: loa.source };
      } else if (diff >= 0.02 - 1e-9) {
        requiredMin = machTableMinutes(mnt.table, diff, rules.longitudinal.other.sameTrackMin);
        rule = { id: 'MNT', text: `Mach Number Technique: ${requiredMin} min (preceding faster by M${diff.toFixed(2)})`, source: mnt.source };
      }
    } else if (loa) {
      requiredMin = loa.sameDirectionMin;
      rule = { id: 'LOA', text: `${loa.name}: ${requiredMin} min`, source: loa.source };
    }
  } else {
    requiredMin = rules.longitudinal.other.crossingMin;
    rule = { id: 'CROSSING', text: `Crossing tracks: ${requiredMin} min`, source: rules.longitudinal.other.source };
  }

  let severity: ConflictSeverity | null = null;
  let margin: number;
  const unc = Math.max(A.uncertaintyMin, B.uncertaintyMin);
  if (requiredNm !== undefined && actualNm !== undefined) {
    margin = actualNm / requiredNm;
    if (actualNm < requiredNm) severity = 'LOS';
    else if (actualNm < requiredNm + rules.warnBufferNm) severity = 'WARN';
  } else {
    margin = actualMin / requiredMin!;
    if (actualMin < requiredMin!) severity = 'LOS';
    else if (actualMin < requiredMin! + rules.warnBufferMin) severity = 'WARN';
    else if (unc > 0 && actualMin - unc < requiredMin!) severity = 'UNVERIFIED';
  }
  if (!severity) return null;
  return {
    kind, severity, margin,
    time: Math.min(timeA, timeB),
    loc,
    actualMin: requiredMin !== undefined ? Math.round(actualMin * 10) / 10 : undefined,
    actualNm: actualNm !== undefined ? Math.round(actualNm * 10) / 10 : undefined,
    requiredMin, requiredNm, rule: rule!,
    fixesA, fixesB,
    note: unc > 0 ? `Position report overdue (${Math.round(unc)} min) – estimates unverified` : undefined,
  };
}

export function probe(flights: ProbeFlight[], ctx: ProbeContext): Conflict[] {
  const segs = flights.map((pf) => segments(pf, ctx));
  const out: Conflict[] = [];
  const marginDeg = (ctx.rules.lateral.otherNm + 40) / 60;
  for (let i = 0; i < flights.length; i++) {
    for (let j = i + 1; j < flights.length; j++) {
      const A = flights[i], B = flights[j];
      let best: Candidate | null = null;
      const fixA = new Set<string>(), fixB = new Set<string>();
      for (const sa of segs[i]) {
        for (const sb of segs[j]) {
          if (sb.minLat > sa.maxLat + marginDeg || sb.maxLat < sa.minLat - marginDeg) continue;
          const lonMargin = marginDeg / Math.max(0.2, Math.cos((sa.minLat * Math.PI) / 180));
          if (sb.minLon > sa.maxLon + lonMargin || sb.maxLon < sa.minLon - lonMargin) continue;
          const c = evalPair(A, B, sa, sb, ctx);
          if (!c || !c.severity) continue;
          c.fixesA.forEach((f) => fixA.add(f));
          c.fixesB.forEach((f) => fixB.add(f));
          if (!best || SEV_RANK[c.severity] > SEV_RANK[best.severity!] || (SEV_RANK[c.severity] === SEV_RANK[best.severity!] && c.margin < best.margin)) {
            best = c;
          }
        }
      }
      if (best && best.severity) {
        const a = A.flight.callsign, b = B.flight.callsign;
        const [x, y] = a < b ? [a, b] : [b, a];
        const fixName = (() => {
          const all = [...A.traj, ...B.traj];
          let bn: string | undefined, bd = Infinity;
          for (const p of all) {
            const d = distanceNm(p, best!.loc);
            if (d < bd) { bd = d; bn = p.name; }
          }
          return bd < 3 ? bn : undefined;
        })();
        out.push({
          id: `${x}|${y}`,
          a, b,
          kind: best.kind,
          severity: best.severity,
          units: ctx.unitsAt(best.loc),
          location: { lat: best.loc.lat, lon: best.loc.lon, fix: fixName },
          time: best.time,
          actualMin: best.actualMin,
          actualNm: best.actualNm,
          requiredMin: best.requiredMin,
          requiredNm: best.requiredNm,
          levelA: fmtLevel(A.flight),
          levelB: fmtLevel(B.flight),
          rule: best.rule,
          fixes: { [a]: [...fixA], [b]: [...fixB] },
          note: best.note,
        });
      }
    }
  }
  out.sort((p, q) => SEV_RANK[q.severity] - SEV_RANK[p.severity] || p.time - q.time);
  return out;
}
