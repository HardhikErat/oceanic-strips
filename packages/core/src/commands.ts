// Controller commands (shared by web board, server and plugin bridge) and
// the PTLMEE position report parser (OCM §7).
import { parseHHMM } from './estimates.ts';
import type { Category, Restriction } from './model.ts';

export type Command =
  | { type: 'report'; callsign: string; unit: string; fix: string; time: number; level?: number; mach?: number; nextFix?: string; nextTime?: number; thenFix?: string; raw?: string }
  | { type: 'estimate'; callsign: string; unit: string; fix: string; time: number; source: 'CTRL' | 'PILOT' | 'COORD' }
  | { type: 'estimate_in'; callsign: string; unit: string; fix: string; time: number; from: string }
  | { type: 'estimate_out'; callsign: string; unit: string; fix: string; time: number; to: string }
  | { type: 'handoff'; callsign: string; unit: string; to: string; freq?: string }
  | { type: 'first_contact'; callsign: string; unit: string }
  | { type: 'adsb_ident'; callsign: string; unit: string; item: 'level' | 'mach'; mach?: number; level?: number }
  | { type: 'selcal_ok'; callsign: string; unit: string }
  | { type: 'next_report'; callsign: string; unit: string; fix: string }
  | { type: 'clear_level'; callsign: string; unit: string; level: number; mach?: number; reportReaching?: boolean; block?: [number, number] }
  | { type: 'level_reached'; callsign: string; unit: string }
  | { type: 'set_mach'; callsign: string; unit: string; mach: number }
  | { type: 'restriction'; callsign: string; unit: string; fix: string; kind: Restriction['kind']; time: number }
  | { type: 'clear_restrictions'; callsign: string; unit: string }
  | { type: 'reroute'; callsign: string; unit: string; route: string }
  | { type: 'deviation'; callsign: string; unit: string; nm: number; side: 'L' | 'R' | 'LR' }
  | { type: 'deviation_end'; callsign: string; unit: string }
  | { type: 'emergency'; callsign: string; unit: string; on: boolean }
  | { type: 'set_category'; callsign: string; unit: string; category: Category | 'AUTO' }
  | { type: 'mark'; callsign: string; unit: string; fix: string; symbol: string; on: boolean }
  | { type: 'free_text'; callsign: string; unit: string; fix: string; text: string }
  | { type: 'activate'; callsign: string; unit: string }
  | { type: 'unpost'; callsign: string; unit: string }
  | { type: 'print'; callsign: string; unit: string }
  | { type: 'remove'; callsign: string; unit: string }
  | { type: 'restore'; callsign: string; unit: string }
  | { type: 'radio_handled'; id: string; unit: string; callsign: string }
  | { type: 'coord_note'; callsign: string; unit: string; to: string; text: string };

export interface ParsedReport {
  fix: string;
  time: number;
  level?: number;
  mach?: number;
  nextFix?: string;
  nextTime?: number;
  thenFix?: string;
}

const isTime = (t: string) => /^\d{4}Z?$/.test(t) || /^\d{1,2}:\d{2}Z?$/.test(t);
const levelOf = (t: string): number | undefined => {
  const m = /^(?:FL|F|A)?(\d{2,3})$/.exec(t);
  return m ? Number(m[1]) : undefined;
};
export const machOf = (t: string): number | undefined => {
  let m = /^M(?:0?\.)?(\d{2,3})$/.exec(t);
  if (!m) m = /^MACH(?:0?\.)?(\d{2,3})$/.exec(t);
  if (!m) m = /^0?\.(\d{2,3})$/.exec(t);
  if (!m) return undefined;
  const d = m[1];
  // ICAO "M082" = Mach 0.82; "785" (thousandths) = 0.785
  return Number(d) / (d.length === 3 && d[0] !== '0' ? 1000 : 100);
};

/**
 * Parse a PTLMEE report: Position, Time, Level, Mach, Estimate next, (next) thereafter.
 * Accepts free order for level/mach and filler words, e.g.
 *   "GIRNA 1715 F350 M080 ELSAR 1755 DUBTA"
 *   "position overhead GIRNA 1715Z FL350 mach .80 estimating ELSAR 1755 DUBTA next"
 */
export function parsePositionReport(text: string, now: number, routeFixes?: string[]): ParsedReport | string {
  const FILLER = new Set(['POSITION', 'POS', 'OVERHEAD', 'OVHD', 'OVER', 'AT', 'ESTIMATING', 'EST', 'NEXT', 'THEREAFTER', 'THEN', 'ZULU', 'Z', 'FLIGHT', 'LEVEL', 'MACH', 'DECIMAL', 'MAINTAINING', 'CLIMBING', 'DESCENDING']);
  const raw = text.toUpperCase().replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  // join "MACH" + ".80" / "DECIMAL 80"
  const toks: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if ((t === 'MACH' || t === 'DECIMAL') && raw[i + 1] && /^(0?\.)?\d{2,3}$/.test(raw[i + 1])) {
      toks.push('M' + raw[i + 1].replace(/^0?\./, ''));
      i++;
      continue;
    }
    if (t === 'FL' && raw[i + 1] && /^\d{2,3}$/.test(raw[i + 1])) { toks.push('F' + raw[i + 1]); i++; continue; }
    if (FILLER.has(t)) continue;
    toks.push(t);
  }
  const fixes: string[] = [];
  const times: number[] = [];
  let level: number | undefined;
  let mach: number | undefined;
  for (const t of toks) {
    if (isTime(t) && (times.length < fixes.length || fixes.length === 0)) {
      const v = parseHHMM(t.replace(/Z$/, ''), now);
      if (v === null) return `Invalid time ${t}`;
      times.push(v);
      continue;
    }
    const m = machOf(t);
    if (m !== undefined && /^M|^\./.test(t)) { mach = m; continue; }
    if (/^(FL|F|A)\d{2,3}$/.test(t) || (/^\d{3}$/.test(t) && times.length >= 1 && level === undefined)) {
      level = levelOf(t.replace(/^FL/, 'F').replace(/^F/, ''));
      continue;
    }
    if (/^[A-Z0-9]{2,11}$/.test(t)) { fixes.push(t); continue; }
    return `Cannot understand "${t}"`;
  }
  if (!fixes.length) return 'Report needs a position';
  if (!times.length) return 'Report needs a time';
  if (routeFixes) {
    for (const f of fixes) if (!routeFixes.includes(f)) return `${f} is not on the flight's route`;
  }
  return {
    fix: fixes[0],
    time: times[0],
    level,
    mach,
    nextFix: fixes[1],
    nextTime: times[1],
    thenFix: fixes[2],
  };
}

/** Keyboard command line: "<CALLSIGN> <VERB> args". Returns a Command or an error string. */
export function parseCommandLine(line: string, unit: string, now: number, routeFixesOf: (cs: string) => string[] | undefined): Command | string {
  const toks = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (toks.length < 2) return 'Usage: <CALLSIGN> <COMMAND> ...  (type HELP)';
  const [callsign, verb, ...args] = toks;
  const fixes = routeFixesOf(callsign);
  if (!fixes) return `No strip for ${callsign}`;
  const time = (s?: string) => (s ? parseHHMM(s.replace(/Z$/, ''), now) : null);
  const needFix = (f?: string) => (f && fixes.includes(f) ? f : null);
  switch (verb) {
    case 'R':
    case 'REP':
    case 'POS': {
      const r = parsePositionReport(args.join(' '), now, fixes);
      if (typeof r === 'string') return r;
      return { type: 'report', callsign, unit, ...r, raw: args.join(' ') };
    }
    case 'EST': {
      const f = needFix(args[0]); const t = time(args[1]);
      if (!f || t === null) return 'EST <fix> <hhmm>';
      return { type: 'estimate', callsign, unit, fix: f, time: t, source: 'CTRL' };
    }
    case 'EIN': {
      const f = needFix(args[0]); const t = time(args[1]);
      if (!f || t === null) return 'EIN <fix> <hhmm> [from]';
      return { type: 'estimate_in', callsign, unit, fix: f, time: t, from: args[2] ?? '' };
    }
    case 'EOUT': {
      const f = needFix(args[0]); const t = time(args[1]);
      if (!f || t === null) return 'EOUT <fix> <hhmm> [to]';
      return { type: 'estimate_out', callsign, unit, fix: f, time: t, to: args[2] ?? '' };
    }
    case 'HO':
      return { type: 'handoff', callsign, unit, to: args[0] ?? '', freq: args[1] };
    case 'CTC':
      return { type: 'first_contact', callsign, unit };
    case 'SEL':
      return { type: 'selcal_ok', callsign, unit };
    case 'NR': {
      const f = needFix(args[0]);
      if (!f) return 'NR <fix>  (next report)';
      return { type: 'next_report', callsign, unit, fix: f };
    }
    case 'CL': {
      const lv = levelOf((args[0] ?? '').replace(/^FL/, '').replace(/^F/, ''));
      if (!lv) return 'CL <level> [M<mach>] [RR]';
      const m = args.map(machOf).find((x) => x !== undefined);
      return { type: 'clear_level', callsign, unit, level: lv, mach: m, reportReaching: true };
    }
    case 'BLK': {
      const a = levelOf(args[0] ?? ''), b = levelOf(args[1] ?? '');
      if (!a || !b) return 'BLK <lower> <upper>';
      return { type: 'clear_level', callsign, unit, level: Math.max(a, b), block: [Math.min(a, b), Math.max(a, b)] };
    }
    case 'RCH':
      return { type: 'level_reached', callsign, unit };
    case 'M': {
      const m = machOf('M' + (args[0] ?? '').replace(/^M/, ''));
      if (m === undefined) return 'M <mach>  e.g. M 080';
      return { type: 'set_mach', callsign, unit, mach: m };
    }
    case 'XB': case 'XA': case 'XT': {
      const f = needFix(args[0]); const t = time(args[1]);
      if (!f || t === null) return `${verb} <fix> <hhmm>`;
      return { type: 'restriction', callsign, unit, fix: f, time: t, kind: verb === 'XB' ? 'AT_OR_BEFORE' : verb === 'XA' ? 'AT_OR_AFTER' : 'AT' };
    }
    case 'RR':
      if (!args.length) return 'RR <new route>';
      return { type: 'reroute', callsign, unit, route: args.join(' ') };
    case 'WX': {
      if (args[0] === 'OFF') return { type: 'deviation_end', callsign, unit };
      const nm = Number(args[0]);
      const side = (args[1] ?? 'LR') as 'L' | 'R' | 'LR';
      if (!nm || !['L', 'R', 'LR'].includes(side)) return 'WX <nm> <L|R|LR>  or  WX OFF';
      return { type: 'deviation', callsign, unit, nm, side };
    }
    case 'EMERG':
      return { type: 'emergency', callsign, unit, on: args[0] !== 'OFF' };
    case 'CAT': {
      const c = args[0];
      if (c !== 'ADSB' && c !== 'OTHER' && c !== 'AUTO') return 'CAT ADSB|OTHER|AUTO';
      return { type: 'set_category', callsign, unit, category: c };
    }
    case 'ACT':
    case 'POST':
      return { type: 'activate', callsign, unit };
    case 'UNPOST':
    case 'PEND':
      return { type: 'unpost', callsign, unit };
    case 'DEL':
      return { type: 'remove', callsign, unit };
    default:
      return `Unknown command ${verb}. Type HELP.`;
  }
}

export const COMMAND_HELP: [string, string][] = [
  ['<CS> R GIRNA 1715 F350 M080 ELSAR 1755 DUBTA', 'Position report (PTLMEE, OCM §7)'],
  ['<CS> EIN KITAL 0053 OOMM', 'Estimate received from previous unit – activates strips'],
  ['<CS> EOUT BIBGO 0255 VRMF', 'Estimate passed to next unit'],
  ['<CS> CTC', 'First contact established'],
  ['<CS> SEL', 'SELCAL check OK'],
  ['<CS> NR NOPEK', 'Next report required over fix'],
  ['<CS> CL 370 M079', 'Clear level (and Mach), report reaching'],
  ['<CS> BLK 350 370', 'Block level clearance'],
  ['<CS> RCH', 'Level reached / confirmed'],
  ['<CS> M 080', 'Assign / confirm Mach'],
  ['<CS> EST BOLUR 0125', 'Revise an estimate'],
  ['<CS> XB DUBTA 1755', 'Cross at or before (XA after, XT at)'],
  ['<CS> RR WIII DUBTA ELSAR', 'Reroute (new Item 15)'],
  ['<CS> WX 20 R', 'Weather deviation up to 20 NM right (WX OFF to end)'],
  ['<CS> EMERG', 'Mark emergency (EMERG OFF to clear)'],
  ['<CS> CAT ADSB', 'Override ADS-B / OTHER category (AUTO to reset)'],
  ['<CS> POST  /  <CS> UNPOST', 'Post strips on the board / take them back to Pending'],
  ['<CS> HO OOMM_1_CTR 128.150', 'Hand off / leaving oceanic airspace'],
];
