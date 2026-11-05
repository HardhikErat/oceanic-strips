// Flight lifecycle: creation from a flight plan, strip printing per unit, and the
// command reducer used by the server (authoritative) and the web board (what-if).
import type { Command } from './commands.ts';
import { computeTrajectory, formatHHMM, locateOnRoute, type TimedPoint, type TrajectoryOptions } from './estimates.ts';
import { classifyCategory, expandRoute, parseAircraftField, parseItem18, typeOfFlight, type NavData } from './fpl.ts';
import { distanceNm, interpolate, type LatLon } from './geo.ts';
import type { CoordEntry, DataSource, Flight, FlightPlan, LivePosition, RoutePoint, UnitState } from './model.ts';
import type { ProbeFlight } from './probe.ts';
import type { SeparationRules } from './rules.ts';
import { stripIndicesForAirspace, type UnitAirspace } from './strips.ts';

const MIN = 60_000;

export interface FlightContext {
  nav: NavData;
  rules: SeparationRules;
  airspaces: UnitAirspace[];
  /** minutes before the entry estimate that strips are printed */
  printLeadMin: number;
  trajectoryOptions?: TrajectoryOptions;
  /** name of the unit/position beyond a boundary point (for "next unit" on strips) */
  neighbourAt?: (p: LatLon & { name?: string }, excludeUnit: string) => string | undefined;
  /** radio name of an Indian unit, e.g. "Mumbai Radio" */
  unitName?: (unit: string) => string;
}

export interface RawFlightPlan {
  callsign: string;
  /** "B77W/H-SDE1E2E3FGHIJ2/LB1D1" or just type */
  aircraft: string;
  aircraftType?: string;
  flightRules?: string;
  adep: string;
  ades: string;
  altn?: string;
  route: string;
  /** feet or FL */
  cruiseLevel: number;
  tas: number;
  remarks: string;
  squawk?: string;
  engineType?: string;
}

export function normaliseFpl(raw: RawFlightPlan, nav: NavData): FlightPlan {
  const ac = parseAircraftField(raw.aircraft);
  const i18 = parseItem18(raw.remarks);
  const type = (raw.aircraftType || ac.type || '').toUpperCase();
  const rfl = raw.cruiseLevel > 1000 ? Math.round(raw.cruiseLevel / 100) : raw.cruiseLevel;
  return {
    callsign: raw.callsign.toUpperCase(),
    aircraftType: type,
    wake: ac.wake,
    equipment: ac.equipment,
    surveillance: ac.surveillance,
    flightRules: raw.flightRules ?? 'I',
    typeOfFlight: typeOfFlight(raw.callsign.toUpperCase(), i18),
    adep: raw.adep.toUpperCase(),
    ades: raw.ades.toUpperCase(),
    altn: (raw.altn ?? '').toUpperCase(),
    route: raw.route.toUpperCase().trim(),
    rfl,
    tas: raw.tas,
    item18: raw.remarks,
    squawk: raw.squawk ?? '',
    engineType: raw.engineType ?? nav.aircraftEngines?.[type],
    dof: i18['DOF'] ? i18['DOF'].slice(4, 6) + i18['DOF'].slice(2, 4) : undefined,
  };
}

export function createFlight(fpl: FlightPlan, ctx: FlightContext, now: number, source: DataSource): Flight {
  const { points, unresolved } = expandRoute(fpl.route, fpl.adep, fpl.ades, ctx.nav);
  const i18 = parseItem18(fpl.item18);
  const cat = classifyCategory(fpl.surveillance, ctx.rules.adsbSurveillanceCodes);
  return {
    callsign: fpl.callsign,
    fpl,
    route: points,
    unresolved,
    category: cat,
    categoryAuto: cat,
    categoryOverridden: false,
    turbojet: (fpl.engineType ?? 'J') === 'J',
    selcal: i18['SEL'],
    pbn: i18['PBN'],
    level: { cleared: fpl.rfl },
    estimates: {},
    atos: {},
    reports: [],
    restrictions: [],
    units: {},
    source,
    lastSeen: now,
    history: [{ at: now, kind: 'FPL', text: `Flight plan received (${source})` }],
  };
}

/** Update an existing flight with a (possibly amended) flight plan. Returns true if the route changed. */
export function amendFlightPlan(f: Flight, fpl: FlightPlan, ctx: FlightContext, now: number): boolean {
  const routeChanged = fpl.route !== f.fpl.route || fpl.adep !== f.fpl.adep || fpl.ades !== f.fpl.ades;
  const old = f.fpl;
  f.fpl = { ...fpl, squawk: fpl.squawk || old.squawk };
  if (fpl.surveillance !== old.surveillance) {
    f.categoryAuto = classifyCategory(fpl.surveillance, ctx.rules.adsbSurveillanceCodes);
    if (!f.categoryOverridden) f.category = f.categoryAuto;
  }
  const i18 = parseItem18(fpl.item18);
  f.selcal = i18['SEL'] ?? f.selcal;
  f.pbn = i18['PBN'] ?? f.pbn;
  if (routeChanged) {
    setRoute(f, fpl.route, ctx, now);
    f.history.push({ at: now, kind: 'FPL', text: `Flight plan route amended` });
  }
  return routeChanged;
}

/** Replace the route with routes from EuroScope (already resolved points). */
export function setResolvedRoute(f: Flight, points: { name: string; lat: number; lon: number }[], ctx: FlightContext, now: number) {
  const key = points.map((p) => p.name).join(' ');
  const cur = f.route.map((p) => p.name).join(' ');
  if (key === cur) return false;
  const { points: expanded } = expandRoute(f.fpl.route, f.fpl.adep, f.fpl.ades, ctx.nav);
  // keep speed/level groups and airway labels from our own expansion where names match
  const byName = new Map(expanded.map((p) => [p.name, p]));
  let d = 0;
  f.route = points.map((p, i) => {
    if (i > 0) d += distanceNm(points[i - 1], p);
    const e = byName.get(p.name);
    return { name: p.name, lat: p.lat, lon: p.lon, distNm: d, airway: e?.airway, speed: e?.speed, levelFl: e?.levelFl, isAirport: p.name === f.fpl.adep || p.name === f.fpl.ades };
  });
  f.unresolved = [];
  reindexUnits(f, ctx, now);
  return true;
}

function setRoute(f: Flight, route: string, ctx: FlightContext, now: number) {
  const { points, unresolved } = expandRoute(route, f.fpl.adep, f.fpl.ades, ctx.nav);
  f.route = points;
  f.unresolved = unresolved;
  // drop data for fixes no longer on route
  const names = new Set(points.map((p) => p.name));
  for (const k of Object.keys(f.estimates)) if (!names.has(k)) delete f.estimates[k];
  for (const k of Object.keys(f.atos)) if (!names.has(k)) delete f.atos[k];
  f.liveNextIndex = undefined;
  reindexUnits(f, ctx, now);
}

function reindexUnits(f: Flight, ctx: FlightContext, now: number) {
  const traj = computeTrajectory(f, now, ctx.trajectoryOptions);
  for (const us of Object.values(f.units)) {
    const air = ctx.airspaces.find((a) => a.id === us.unit);
    if (!air) continue;
    const idx = stripIndicesForAirspace(f.route, air);
    us.pointIndices = idx;
    if (idx.length) {
      us.entryFix = f.route[idx[0]].name;
      us.exitFix = f.route[idx[idx.length - 1]].name;
    }
    us.printedEtos = Object.fromEntries(idx.map((i) => [f.route[i].name, traj[i]?.eto ?? NaN]).filter(([, t]) => Number.isFinite(t)));
  }
}

/** Print the strip set for a unit (creates the unit state). */
export function printUnit(f: Flight, unit: string, ctx: FlightContext, now: number, traj?: TimedPoint[]): UnitState | null {
  if (f.units[unit]) return f.units[unit];
  const air = ctx.airspaces.find((a) => a.id === unit);
  if (!air) return null;
  const idx = stripIndicesForAirspace(f.route, air);
  if (!idx.length) return null;
  const t = traj ?? computeTrajectory(f, now, ctx.trajectoryOptions);
  const entry = f.route[idx[0]];
  const exit = f.route[idx[idx.length - 1]];
  // look 30 NM beyond the boundary point along the route to find the adjacent unit
  const probePoint = (from: RoutePoint, to: RoutePoint | undefined) => {
    if (!to) return undefined;
    const d = distanceNm(from, to);
    const p = interpolate(from, to, d > 0 ? Math.min(1, 30 / d) : 1);
    return { ...p, name: from.name };
  };
  const beyondExit = probePoint(exit, f.route[idx[idx.length - 1] + 1]);
  const beforeEntry = probePoint(entry, f.route[idx[0] - 1]);
  // another Indian oceanic unit whose strips start at (or right after) our exit point is the
  // next unit, even if the gap between the two boundaries crosses a corner of a foreign FIR
  const adjacentUnit = (atIndex: number, step: 1 | -1) => {
    for (const other of ctx.airspaces) {
      if (other.id === unit) continue;
      const o = stripIndicesForAirspace(f.route, other);
      if (o.includes(atIndex) || o.includes(atIndex + step)) return other.id;
    }
    return undefined;
  };
  const nextIndian = adjacentUnit(idx[idx.length - 1], 1);
  const prevIndian = adjacentUnit(idx[0], -1);
  const us: UnitState = {
    unit,
    phase: 'PENDING',
    printedAt: now,
    pointIndices: idx,
    entryFix: entry.name,
    exitFix: exit.name,
    nextUnit: nextIndian ?? (beyondExit ? ctx.neighbourAt?.(beyondExit, unit) : undefined),
    prevUnit: prevIndian ?? (beforeEntry ? ctx.neighbourAt?.(beforeEntry, unit) : undefined),
    marks: {},
    printedEtos: Object.fromEntries(idx.map((i) => [f.route[i].name, t[i]?.eto ?? NaN]).filter(([, v]) => Number.isFinite(v as number))),
  };
  f.units[unit] = us;
  f.history.push({ at: now, unit, kind: 'PRINT', text: `${idx.length} strips printed (${us.entryFix} ${formatHHMM(t[idx[0]]?.eto)} → ${us.exitFix})` });
  return us;
}

/**
 * Periodic housekeeping: print strips when due, and record system ATOs for ADS-B aircraft
 * as their live position passes route points (no position reports required, OCM §8.1).
 */
export function tickFlight(f: Flight, ctx: FlightContext, now: number): TimedPoint[] {
  if (f.live && f.category === 'ADSB') {
    const loc = locateOnRoute(f.route, f.live);
    if (loc && loc.crossTrackNm < 60) {
      const prev = f.liveNextIndex;
      if (prev !== undefined && loc.nextIndex > prev && loc.nextIndex - prev <= 3) {
        for (let i = prev; i < loc.nextIndex; i++) {
          const p = f.route[i];
          if (!f.atos[p.name] && !p.isAirport) f.atos[p.name] = { time: now, source: 'SYSTEM', at: now, by: 'ADS-B' };
        }
      }
      f.liveNextIndex = loc.nextIndex;
    }
  }
  const traj = computeTrajectory(f, now, ctx.trajectoryOptions);
  for (const air of ctx.airspaces) {
    if (f.units[air.id]) continue;
    const idx = stripIndicesForAirspace(f.route, air);
    if (!idx.length) continue;
    const lastIdx = idx[idx.length - 1];
    const entryEto = traj[idx[0]]?.eto;
    const exitEto = traj[lastIdx]?.eto;
    if (exitEto !== undefined && exitEto < now - 5 * MIN) continue; // already through
    if (entryEto !== undefined && entryEto - now <= ctx.printLeadMin * MIN) printUnit(f, air.id, ctx, now, traj);
  }
  return traj;
}

export function overdueMinutes(f: Flight, traj: TimedPoint[], now: number, rules: SeparationRules): number {
  if (f.category !== 'OTHER') return 0;
  let worst = 0;
  for (const us of Object.values(f.units)) {
    if (us.phase !== 'ACTIVE' || !us.contact || !us.nextReportFix) continue;
    const p = traj.find((x) => x.name === us.nextReportFix);
    if (!p || p.ato !== undefined || p.eto === undefined) continue;
    const late = (now - p.eto) / MIN - rules.overdueMin;
    if (late > 0) worst = Math.max(worst, late + rules.overdueMin);
  }
  return worst;
}

export function toProbeFlight(f: Flight, traj: TimedPoint[], now: number, rules: SeparationRules): ProbeFlight {
  const entryFixes = Object.values(f.units)
    .map((u) => f.route[u.pointIndices[0]])
    .filter(Boolean)
    .map((p) => ({ lat: p.lat, lon: p.lon }));
  return { flight: f, traj, entryFixes, uncertaintyMin: overdueMinutes(f, traj, now, rules) };
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  coord?: CoordEntry[];
  /** level/Mach changes to push back to EuroScope */
  esAmend?: { clearedFl?: number; mach?: number; annotation?: string };
}

function nextUnpassed(f: Flight, us: UnitState, traj: TimedPoint[]): string | undefined {
  for (const i of us.pointIndices) if (!traj[i]?.passed && traj[i]?.ato === undefined) return f.route[i].name;
  return undefined;
}

/** Apply a controller command to a flight. Mutates `f`. */
export function applyCommand(f: Flight, cmd: Command, ctx: FlightContext, now: number, by?: string): ApplyResult {
  if (!('callsign' in cmd) || cmd.callsign !== f.callsign) return { ok: false, error: 'callsign mismatch' };
  const unit = cmd.unit;
  const us = f.units[unit];
  const log = (kind: string, text: string) => f.history.push({ at: now, by, unit, kind, text });
  const routeNames = f.route.map((p) => p.name);
  const needUnit = () => {
    if (!us) throw new Error(`No ${unit} strips for ${f.callsign}`);
    return us;
  };
  try {
    switch (cmd.type) {
      case 'report': {
        if (!routeNames.includes(cmd.fix)) return { ok: false, error: `${cmd.fix} not on route` };
        f.atos[cmd.fix] = { time: cmd.time, source: 'ATO', at: now, by };
        const idx = routeNames.indexOf(cmd.fix);
        // a new report supersedes downstream explicit estimates (they are recalculated)
        for (let i = idx; i < routeNames.length; i++) {
          const e = f.estimates[routeNames[i]];
          if (e && e.source !== 'COORD') delete f.estimates[routeNames[i]];
          if (e && e.source === 'COORD' && e.at < now) delete f.estimates[routeNames[i]];
        }
        if (cmd.nextFix && cmd.nextTime !== undefined) f.estimates[cmd.nextFix] = { time: cmd.nextTime, source: 'PILOT', at: now, by };
        if (cmd.mach !== undefined) f.mach = cmd.mach;
        if (cmd.level !== undefined) {
          if (cmd.level === f.level.cleared) f.level.confirmed = true;
          else log('LEVEL', `Reported F${cmd.level} – cleared F${f.level.cleared}!`);
        }
        f.reports.push({ fix: cmd.fix, time: cmd.time, level: cmd.level, mach: cmd.mach, nextFix: cmd.nextFix, nextTime: cmd.nextTime, thenFix: cmd.thenFix, receivedAt: now, by, raw: cmd.raw });
        if (us) {
          if (!us.contact) us.contact = { at: now };
          if (us.phase === 'PENDING') us.phase = 'ACTIVE';
          const traj = computeTrajectory(f, now, ctx.trajectoryOptions);
          us.nextReportFix = cmd.nextFix && us.pointIndices.some((i) => f.route[i].name === cmd.nextFix) ? cmd.nextFix : nextUnpassed(f, us, traj);
        }
        log('REPORT', `${cmd.fix} ${formatHHMM(cmd.time)}${cmd.level ? ` F${cmd.level}` : ''}${cmd.mach ? ` M${(cmd.mach * 100).toFixed(0).padStart(3, '0')}` : ''}${cmd.nextFix ? ` ${cmd.nextFix} ${formatHHMM(cmd.nextTime)}` : ''}${cmd.thenFix ? ` ${cmd.thenFix}` : ''}`);
        return { ok: true, esAmend: { annotation: `${cmd.fix} ${formatHHMM(cmd.time)}` } };
      }
      case 'estimate': {
        const old = computeTrajectory(f, now, ctx.trajectoryOptions).find((p) => p.name === cmd.fix)?.eto;
        f.estimates[cmd.fix] = { time: cmd.time, source: cmd.source, at: now, by };
        log('EST', `${cmd.fix} ${formatHHMM(old)} → ${formatHHMM(cmd.time)}`);
        return { ok: true };
      }
      case 'estimate_in': {
        const u = us ?? printUnit(f, unit, ctx, now);
        if (!u) return { ok: false, error: `${f.callsign} does not route through ${unit}` };
        u.estimateIn = { fix: cmd.fix, time: cmd.time, from: cmd.from, at: now, by };
        if (cmd.from) u.prevUnit = cmd.from;
        f.estimates[cmd.fix] = { time: cmd.time, source: 'COORD', at: now, by };
        if (u.phase === 'PENDING') u.phase = 'ACTIVE';
        log('EST_IN', `Estimate ${cmd.fix} ${formatHHMM(cmd.time)} from ${cmd.from || 'previous unit'}`);
        return { ok: true, coord: [{ at: now, from: cmd.from || '?', to: unit, callsign: f.callsign, kind: 'ESTIMATE', text: `${f.callsign} ${cmd.fix} ${formatHHMM(cmd.time)} F${f.level.cleared}${f.mach ? ` M${Math.round(f.mach * 100)}` : ''}`, by }] };
      }
      case 'estimate_out': {
        const u = needUnit();
        u.estimateOut = { fix: cmd.fix, time: cmd.time, to: cmd.to, at: now, by };
        if (cmd.to) u.nextUnit = cmd.to;
        log('EST_OUT', `Estimate ${cmd.fix} ${formatHHMM(cmd.time)} passed to ${cmd.to || 'next unit'}`);
        return { ok: true, coord: [{ at: now, from: unit, to: cmd.to || '?', callsign: f.callsign, kind: 'ESTIMATE', text: `${f.callsign} ${cmd.fix} ${formatHHMM(cmd.time)} F${f.level.cleared}${f.mach ? ` M${Math.round(f.mach * 100)}` : ''}${f.selcal ? ` SEL ${f.selcal}` : ''}`, by }] };
      }
      case 'handoff': {
        const u = needUnit();
        u.handoff = { to: cmd.to, freq: cmd.freq, at: now, by };
        u.phase = 'HANDED_OFF';
        log('HANDOFF', `Leaving ${ctx.unitName?.(unit) ?? unit}, contact ${cmd.to}${cmd.freq ? ` ${cmd.freq}` : ''}`);
        return { ok: true, coord: [{ at: now, from: unit, to: cmd.to, callsign: f.callsign, kind: 'HANDOFF', text: `${f.callsign} transferred${cmd.freq ? ` on ${cmd.freq}` : ''}`, by }] };
      }
      case 'first_contact': {
        const u = needUnit();
        u.contact = u.contact ?? { at: now };
        if (u.phase === 'PENDING') u.phase = 'ACTIVE';
        if (f.category === 'OTHER') u.nextReportFix = nextUnpassed(f, u, computeTrajectory(f, now, ctx.trajectoryOptions));
        log('CONTACT', `First contact on ${ctx.unitName?.(unit) ?? unit}`);
        return { ok: true };
      }
      case 'adsb_ident': {
        const u = needUnit();
        u.contact = u.contact ?? { at: now };
        if (u.phase === 'PENDING') u.phase = 'ACTIVE';
        if (cmd.item === 'level') {
          u.contact.adsbLevel = true;
          if (cmd.level !== undefined && cmd.level !== f.level.cleared) {
            // aircraft is flying a different level from the flight plan: the strip takes the level it reports
            log('IDENT', `F${cmd.level} copied (ADS-B identification) – flight plan F${f.level.cleared}`);
            f.level = { cleared: cmd.level, previous: f.level.cleared, confirmed: true };
            u.contact.adsbLevel = true;
            return { ok: true, esAmend: { clearedFl: cmd.level } };
          }
          f.level.confirmed = true;
          log('IDENT', `F${f.level.cleared} copied (ADS-B identification)`);
        }
        else { u.contact.adsbMach = true; if (cmd.mach) f.mach = cmd.mach; log('IDENT', `Mach ${f.mach ? `.${Math.round(f.mach * 100)}` : ''} copied (ADS-B identification)`); }
        return { ok: true, esAmend: cmd.item === 'mach' && f.mach ? { mach: f.mach } : undefined };
      }
      case 'selcal_ok': {
        const u = needUnit();
        u.contact = u.contact ?? { at: now };
        u.contact.selcal = true;
        log('SELCAL', `SELCAL check OK${f.selcal ? ` (${f.selcal})` : ''}`);
        return { ok: true };
      }
      case 'next_report': {
        const u = needUnit();
        u.nextReportFix = cmd.fix;
        log('NEXT_REPORT', `Report overhead ${cmd.fix}`);
        return { ok: true };
      }
      case 'clear_level': {
        const prev = f.level.cleared;
        f.level = {
          cleared: cmd.level,
          previous: prev !== cmd.level ? prev : f.level.previous,
          changeStartedAt: prev !== cmd.level ? now : f.level.changeStartedAt,
          reportReaching: cmd.reportReaching ?? true,
          confirmed: prev === cmd.level,
          block: cmd.block,
        };
        if (cmd.mach !== undefined) f.mach = cmd.mach;
        log('LEVEL', cmd.block ? `Block F${cmd.block[0]}–F${cmd.block[1]}` : `${cmd.level > prev ? 'Climb' : cmd.level < prev ? 'Descend' : 'Maintain'} F${cmd.level}${cmd.mach ? `, Mach .${Math.round(cmd.mach * 100)}` : ''}, report reaching`);
        return { ok: true, esAmend: { clearedFl: cmd.level, mach: cmd.mach } };
      }
      case 'level_reached': {
        f.level.confirmed = true;
        log('LEVEL', `Reaching F${f.level.cleared}`);
        return { ok: true };
      }
      case 'set_mach': {
        const old = f.mach;
        f.mach = cmd.mach;
        log('MACH', `Mach ${old ? `.${Math.round(old * 100)} → ` : ''}.${Math.round(cmd.mach * 100)}`);
        return { ok: true, esAmend: { mach: cmd.mach } };
      }
      case 'restriction': {
        f.restrictions = f.restrictions.filter((r) => r.fix !== cmd.fix);
        f.restrictions.push({ fix: cmd.fix, kind: cmd.kind, time: cmd.time, at: now });
        const eto = computeTrajectory(f, now, ctx.trajectoryOptions).find((p) => p.name === cmd.fix)?.eto;
        let planned = cmd.time;
        if (eto !== undefined && cmd.kind === 'AT_OR_BEFORE') planned = Math.min(eto, cmd.time);
        if (eto !== undefined && cmd.kind === 'AT_OR_AFTER') planned = Math.max(eto, cmd.time);
        f.estimates[cmd.fix] = { time: planned, source: 'CTRL', at: now, by };
        const word = cmd.kind === 'AT_OR_BEFORE' ? 'at or before' : cmd.kind === 'AT_OR_AFTER' ? 'after' : 'at';
        log('RESTRICTION', `Cross ${cmd.fix} ${word} ${formatHHMM(cmd.time)}z`);
        return { ok: true };
      }
      case 'clear_restrictions':
        f.restrictions = [];
        log('RESTRICTION', 'Restrictions cancelled');
        return { ok: true };
      case 'reroute': {
        const old = f.fpl.route;
        f.fpl = { ...f.fpl, route: cmd.route.toUpperCase() };
        setRoute(f, f.fpl.route, ctx, now);
        if (f.unresolved.length) log('REROUTE', `Unresolved: ${f.unresolved.join(' ')}`);
        log('REROUTE', `Recleared via ${cmd.route} (was ${old})`);
        return { ok: true };
      }
      case 'deviation':
        f.deviation = { side: cmd.side, nm: cmd.nm, since: now };
        log('WX', `Weather deviation up to ${cmd.nm} NM ${cmd.side === 'L' ? 'left' : cmd.side === 'R' ? 'right' : 'either side'} of track`);
        return { ok: true };
      case 'deviation_end':
        f.deviation = undefined;
        log('WX', 'Back on track');
        return { ok: true };
      case 'emergency':
        f.emergency = cmd.on;
        log('EMERG', cmd.on ? 'EMERGENCY declared' : 'Emergency cancelled');
        return { ok: true };
      case 'set_category':
        if (cmd.category === 'AUTO') { f.categoryOverridden = false; f.category = f.categoryAuto; }
        else { f.categoryOverridden = true; f.category = cmd.category; }
        log('CAT', `Category ${f.category}${f.categoryOverridden ? ' (controller)' : ' (auto)'}`);
        return { ok: true };
      case 'mark': {
        const u = needUnit();
        const m = (u.marks[cmd.fix] = u.marks[cmd.fix] ?? {});
        const set = new Set(m.symbols ?? []);
        if (cmd.on) set.add(cmd.symbol); else set.delete(cmd.symbol);
        m.symbols = [...set];
        return { ok: true };
      }
      case 'free_text': {
        const u = needUnit();
        const m = (u.marks[cmd.fix] = u.marks[cmd.fix] ?? {});
        m.text = cmd.text;
        return { ok: true };
      }
      case 'activate': {
        const u = us ?? printUnit(f, unit, ctx, now);
        if (!u) return { ok: false, error: `${f.callsign} does not route through ${unit}` };
        u.phase = 'ACTIVE';
        log('ACTIVATE', 'Strips posted on board');
        return { ok: true };
      }
      case 'print': {
        const u = printUnit(f, unit, ctx, now);
        if (!u) return { ok: false, error: `${f.callsign} does not route through ${unit}` };
        return { ok: true };
      }
      case 'remove':
        if (us) { delete f.units[unit]; log('REMOVE', 'Strips removed from board'); }
        return { ok: true };
      case 'restore': {
        const u = printUnit(f, unit, ctx, now);
        return u ? { ok: true } : { ok: false, error: 'Cannot reprint' };
      }
      case 'coord_note':
        log('COORD', `${cmd.to}: ${cmd.text}`);
        return { ok: true, coord: [{ at: now, from: unit, to: cmd.to, callsign: f.callsign, kind: 'FREE', text: cmd.text, by }] };
      default:
        return { ok: false, error: 'Unsupported command' };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Deep clone for what-if probing in the browser. */
export function cloneFlight(f: Flight): Flight {
  return JSON.parse(JSON.stringify(f));
}

export function updateLive(f: Flight, live: LivePosition) {
  f.live = live;
  f.lastSeen = live.time;
}
