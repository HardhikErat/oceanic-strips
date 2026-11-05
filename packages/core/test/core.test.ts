import { describe, expect, it } from 'vitest';
import {
  INDIA_OCM_RULES,
  applyCommand,
  computeTrajectory,
  createFlight,
  expandRoute,
  normaliseFpl,
  parseCommandLine,
  parsePositionReport,
  probe,
  stripIndicesForAirspace,
  toProbeFlight,
  machToTasKt,
  printUnit,
  type Flight,
  type FlightContext,
  type NavData,
  type SeparationRules,
} from '../src/index.ts';

// Synthetic navigation data (no AeroNav data in tests).
// East-west airway W1 along 15N, north-south airway N1 along 64E, parallel airway W2 along 16N/15.5N.
function buildNav(): NavData {
  const fixes: NavData['fixes'] = {};
  const airways: NavData['airways'] = { W1: {}, N1: {}, W2: {}, W3: {} };
  const add = (aw: string, list: [string, number, number][]) => {
    list.forEach(([n, lat, lon], i) => {
      fixes[n] = [{ lat, lon }];
      airways[aw][n] = { lat, lon, next: [list[i - 1]?.[0], list[i + 1]?.[0]].filter(Boolean) as string[] };
    });
  };
  add('W1', [['AAA60', 15, 60], ['AAA62', 15, 62], ['AAA64', 15, 64], ['AAA66', 15, 66], ['AAA68', 15, 68]]);
  add('N1', [['NNN19', 19, 64], ['NNN17', 17, 64], ['AAA64', 15, 64], ['NNN13', 13, 64], ['NNN11', 11, 64]]);
  // 70 NM north of W1 (15N + 70/60 deg)
  const lat70 = 15 + 70 / 60;
  add('W2', [['BBB60', lat70, 60], ['BBB64', lat70, 64], ['BBB68', lat70, 68]]);
  const lat40 = 15 + 40 / 60;
  add('W3', [['CCC60', lat40, 60], ['CCC64', lat40, 64], ['CCC68', lat40, 68]]);
  return { fixes, airways, airports: {}, aircraftEngines: { B77W: 'J', A320: 'J', AT76: 'T' } };
}

const nav = buildNav();
const rules: SeparationRules = JSON.parse(JSON.stringify(INDIA_OCM_RULES));
rules.loas[0].tcps = ['AAA60'];
const ctx: FlightContext = {
  nav,
  rules,
  printLeadMin: 60,
  airspaces: [{ id: 'VABX', polygons: [[{ lat: 5, lon: 59 }, { lat: 25, lon: 59 }, { lat: 25, lon: 70 }, { lat: 5, lon: 70 }]] }],
};

const T0 = Date.UTC(2026, 10, 5, 10, 0);
const MIN = 60_000;

function mk(cs: string, route: string, level: number, opts: { surv?: string; type?: string; tas?: number; mach?: number; first?: string; at?: number } = {}): Flight {
  const fpl = normaliseFpl(
    {
      callsign: cs,
      aircraft: `${opts.type ?? 'B77W'}/H-SDE1E2E3FGHIJ2/${opts.surv ?? 'L'}`,
      adep: 'XXXX',
      ades: 'YYYY',
      route,
      cruiseLevel: level,
      tas: opts.tas ?? 480,
      remarks: 'PBN/A1B1C1D1L1 SEL/DQCM',
    },
    nav,
  );
  const f = createFlight(fpl, ctx, T0, 'MANUAL');
  if (opts.mach) f.mach = opts.mach;
  const first = opts.first ?? f.route[0].name;
  f.estimates[first] = { time: opts.at ?? T0, source: 'COORD', at: T0 };
  // print strips
  f.units['VABX'] = {
    unit: 'VABX', phase: 'ACTIVE', printedAt: T0, marks: {},
    pointIndices: stripIndicesForAirspace(f.route, ctx.airspaces[0]),
    entryFix: f.route[0].name, exitFix: f.route[f.route.length - 1].name,
  };
  return f;
}

function run(...fs: Flight[]) {
  const pfs = fs.map((f) => toProbeFlight(f, computeTrajectory(f, T0), T0, rules));
  return probe(pfs, { rules, now: T0, unitsAt: () => ['VABX'] });
}

describe('geometry & route', () => {
  it('expands airways between fixes', () => {
    const r = expandRoute('N0480F350 AAA60 W1 AAA68', 'XXXX', 'YYYY', nav);
    expect(r.points.map((p) => p.name)).toEqual(['AAA60', 'AAA62', 'AAA64', 'AAA66', 'AAA68']);
    expect(r.unresolved).toEqual([]);
    expect(r.points[0].speed).toEqual({ kind: 'N', value: 480 });
  });
  it('parses speed/level change groups and lat/long points', () => {
    const r = expandRoute('AAA60 W1 AAA64/M083F370 DCT 1530N06600E', 'XXXX', 'YYYY', nav);
    expect(r.points.map((p) => p.name)).toEqual(['AAA60', 'AAA62', 'AAA64', '1530N06600E']);
    expect(r.points[2].speed).toEqual({ kind: 'M', value: 0.83 });
    expect(r.points[2].levelFl).toBe(370);
    expect(r.points[3].lat).toBeCloseTo(15.5);
  });
  it('an airway named like a Mach group (M300) is still an airway', () => {
    const n = buildNav();
    n.airways['M300'] = JSON.parse(JSON.stringify(n.airways['W1']));
    const r = expandRoute('AAA60 M300 AAA66', 'XXXX', 'YYYY', n);
    expect(r.points.map((p) => p.name)).toEqual(['AAA60', 'AAA62', 'AAA64', 'AAA66']);
  });
  it('Mach to TAS at FL350 (ISA)', () => {
    expect(machToTasKt(0.8, 350)).toBeGreaterThan(455);
    expect(machToTasKt(0.8, 350)).toBeLessThan(465);
  });
});

describe('PTLMEE position reports (OCM §7)', () => {
  const now = Date.UTC(2026, 10, 5, 17, 10);
  it('parses compact form', () => {
    const r = parsePositionReport('GIRNA 1715 F350 M080 ELSAR 1755 DUBTA', now);
    expect(r).toMatchObject({ fix: 'GIRNA', level: 350, mach: 0.8, nextFix: 'ELSAR', thenFix: 'DUBTA' });
    if (typeof r !== 'string') {
      expect(new Date(r.time).getUTCHours()).toBe(17);
      expect(new Date(r.nextTime!).getUTCMinutes()).toBe(55);
    }
  });
  it('parses spoken form from the manual', () => {
    const r = parsePositionReport('position overhead GIRNA 1715 Zulu, FL350, Mach decimal 80, estimating ELSAR 1755 Zulu, DUBTA next', now);
    expect(r).toMatchObject({ fix: 'GIRNA', level: 350, mach: 0.8, nextFix: 'ELSAR', thenFix: 'DUBTA' });
  });
  it('rejects fixes not on route', () => {
    expect(typeof parsePositionReport('XXXXX 1715', now, ['GIRNA'])).toBe('string');
  });
  it('parses command line', () => {
    const c = parseCommandLine('QTR8E CL 370 M079', 'VABX', now, () => ['KITAL']);
    expect(c).toMatchObject({ type: 'clear_level', level: 370, mach: 0.79 });
  });
});

describe('estimates', () => {
  it('pilot report anchors downstream estimates', () => {
    const f = mk('TST1', 'AAA60 W1 AAA68', 350);
    applyCommand(f, { type: 'report', callsign: 'TST1', unit: 'VABX', fix: 'AAA62', time: T0 + 20 * MIN, level: 350, mach: 0.84, nextFix: 'AAA64', nextTime: T0 + 35 * MIN }, ctx, T0 + 20 * MIN);
    const t = computeTrajectory(f, T0 + 20 * MIN);
    expect(t[1].ato).toBe(T0 + 20 * MIN);
    expect(t[2].eto).toBe(T0 + 35 * MIN);
    expect(t[2].source).toBe('PILOT');
    expect(t[3].eto! - t[2].eto!).toBeGreaterThan(13 * MIN);
    expect(f.units.VABX.nextReportFix).toBe('AAA64');
    expect(f.level.confirmed).toBe(true);
  });
});

describe('unit hand-over', () => {
  it('next unit is the adjacent Indian oceanic unit even across a gap', () => {
    const two: FlightContext = {
      ...ctx,
      airspaces: [
        { id: 'VECX', polygons: [[{ lat: 10, lon: 59 }, { lat: 20, lon: 59 }, { lat: 20, lon: 62.5 }, { lat: 10, lon: 62.5 }]] },
        // starts just before AAA66, leaving a gap after AAA62 (someone else's FIR)
        { id: 'VOMX', polygons: [[{ lat: 10, lon: 65.98 }, { lat: 20, lon: 65.98 }, { lat: 20, lon: 70 }, { lat: 10, lon: 70 }]] },
      ],
      neighbourAt: () => 'VYYF_4_CTR',
    };
    const f = createFlight(normaliseFpl({ callsign: 'IGO53', aircraft: 'A21N/M-SDE1/L', adep: 'XXXX', ades: 'YYYY', route: 'AAA60 W1 AAA68', cruiseLevel: 350, tas: 450, remarks: '' }, nav), two, T0, 'MANUAL');
    f.estimates['AAA60'] = { time: T0, source: 'COORD', at: T0 };
    const vecx = printUnit(f, 'VECX', two, T0)!;
    expect(vecx.pointIndices.map((i) => f.route[i].name)).toEqual(['AAA60', 'AAA62']);
    expect(vecx.nextUnit).toBe('VYYF_4_CTR'); // AAA64 is in the gap: foreign FIR next
    const vomx = printUnit(f, 'VOMX', two, T0)!;
    expect(vomx.prevUnit).toBe('VYYF_4_CTR');
  });
  it('next unit is the other Indian unit when its strips start right after our exit', () => {
    const two: FlightContext = {
      ...ctx,
      airspaces: [
        { id: 'VECX', polygons: [[{ lat: 10, lon: 59 }, { lat: 20, lon: 59 }, { lat: 20, lon: 63 }, { lat: 10, lon: 63 }]] },
        { id: 'VOMX', polygons: [[{ lat: 10, lon: 63.5 }, { lat: 20, lon: 63.5 }, { lat: 20, lon: 70 }, { lat: 10, lon: 70 }]] },
      ],
      neighbourAt: () => 'VYYF_4_CTR',
    };
    const f = createFlight(normaliseFpl({ callsign: 'IGO53', aircraft: 'A21N/M-SDE1/L', adep: 'XXXX', ades: 'YYYY', route: 'AAA60 W1 AAA68', cruiseLevel: 350, tas: 450, remarks: '' }, nav), two, T0, 'MANUAL');
    f.estimates['AAA60'] = { time: T0, source: 'COORD', at: T0 };
    expect(printUnit(f, 'VECX', two, T0)!.nextUnit).toBe('VOMX');
    expect(printUnit(f, 'VOMX', two, T0)!.prevUnit).toBe('VECX');
  });
});

describe('ADS-B identification (OCM §8.1)', () => {
  it('FL copied takes the level the aircraft is actually flying', () => {
    const f = mk('UAE7MY', 'AAA60 W1 AAA68', 350, { surv: 'LB1' });
    const r = applyCommand(f, { type: 'adsb_ident', callsign: 'UAE7MY', unit: 'VABX', item: 'level', level: 390 }, ctx, T0);
    expect(r.esAmend).toEqual({ clearedFl: 390 });
    expect(f.level).toMatchObject({ cleared: 390, confirmed: true });
    // and the probe now separates it from FL350 traffic
    const other = mk('B1', 'AAA60 W1 AAA68', 350, { at: T0 + 2 * MIN });
    expect(run(f, other)).toHaveLength(0);
  });
});

describe('separation (OCM §6 / LoA)', () => {
  it('same track, other aircraft: 13 min is separated', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 350), mk('B1', 'AAA60 W1 AAA68', 350, { at: T0 + 13 * MIN }))).toHaveLength(0);
  });
  it('same track, other aircraft: 8 min is loss of separation (10 min required)', () => {
    const c = run(mk('A1', 'AAA60 W1 AAA68', 350), mk('B1', 'AAA60 W1 AAA68', 350, { at: T0 + 8 * MIN }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ severity: 'LOS', kind: 'SAME', requiredMin: 10 });
    expect(c[0].fixes['A1']).toContain('AAA62');
  });
  it('same track 11 min is a warning (buffer 2 min)', () => {
    const c = run(mk('A1', 'AAA62 W1 AAA68', 350), mk('B1', 'AAA62 W1 AAA68', 350, { at: T0 + 11 * MIN }));
    expect(c[0]?.severity).toBe('WARN');
  });
  it('1000 ft vertical separation below FL410', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 350), mk('B1', 'AAA60 W1 AAA68', 360, { at: T0 + 2 * MIN }))).toHaveLength(0);
  });
  it('2000 ft required above FL410', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 410), mk('B1', 'AAA60 W1 AAA68', 420, { at: T0 + 2 * MIN }))[0]?.severity).toBe('LOS');
    expect(run(mk('A1', 'AAA60 W1 AAA68', 410), mk('B1', 'AAA60 W1 AAA68', 430, { at: T0 + 2 * MIN }))).toHaveLength(0);
  });
  it('Mach Number Technique: preceding faster by 0.04 -> 7 min (OCM 6.3.2)', () => {
    const a = mk('A1', 'AAA62 W1 AAA68', 350, { mach: 0.84 });
    const b = mk('B1', 'AAA62 W1 AAA68', 350, { mach: 0.8, at: T0 + 7.5 * MIN });
    const c = run(a, b);
    expect(c[0]?.severity).not.toBe('LOS');
    expect(c[0]?.requiredMin).toBe(7);
    expect(c[0]?.rule.id).toBe('MNT');
    const b2 = mk('B2', 'AAA62 W1 AAA68', 350, { mach: 0.8, at: T0 + 6 * MIN });
    expect(run(a, b2)[0]).toMatchObject({ severity: 'LOS', requiredMin: 7 });
  });
  it('MNT does not apply to turboprops', () => {
    const a = mk('A1', 'AAA62 W1 AAA68', 250, { mach: 0.6, type: 'AT76', tas: 280 });
    const b = mk('B1', 'AAA62 W1 AAA68', 250, { mach: 0.5, type: 'AT76', tas: 260, at: T0 + 8 * MIN });
    expect(run(a, b)[0]).toMatchObject({ severity: 'LOS', requiredMin: 10 });
  });
  it('India–Oman LoA at the TCP: 8 min for 0.03 faster', () => {
    const a = mk('A1', 'AAA60 W1 AAA62', 350, { mach: 0.83 });
    const b = mk('B1', 'AAA60 W1 AAA62', 350, { mach: 0.8, at: T0 + 7 * MIN });
    const c = run(a, b);
    expect(c[0]).toMatchObject({ severity: 'LOS', requiredMin: 8 });
    expect(c[0].rule.id).toBe('LOA');
  });
  it('crossing tracks need 15 min: 12 min apart is a loss of separation', () => {
    const a = mk('A1', 'AAA60 W1 AAA68', 350, { first: 'AAA60' });
    // A reaches AAA64 after ~29 min; B reaches AAA64 at 29+12
    const tA = computeTrajectory(a, T0).find((p) => p.name === 'AAA64')!.eto!;
    const b = mk('B1', 'NNN19 N1 NNN11', 350, { first: 'AAA64', at: tA + 12 * MIN });
    const c = run(a, b);
    expect(c[0]).toMatchObject({ kind: 'CROSSING', severity: 'LOS', requiredMin: 15 });
    expect(c[0].location.fix).toBe('AAA64');
  });
  it('parallel routes 70 NM apart are laterally separated (60 NM)', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 350), mk('B1', 'BBB60 W2 BBB68', 350))).toHaveLength(0);
  });
  it('parallel routes 40 NM apart: lateral 60 NM not met for other aircraft', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 350), mk('B1', 'CCC60 W3 CCC68', 350, { at: T0 + 3 * MIN }))[0]?.severity).toBe('LOS');
  });
  it('ADS-B pair 40 NM apart is laterally separated (19 NM)', () => {
    expect(run(mk('A1', 'AAA60 W1 AAA68', 350, { surv: 'LB1' }), mk('B1', 'CCC60 W3 CCC68', 350, { surv: 'LB1', at: T0 + 3 * MIN }))).toHaveLength(0);
  });
  it('ADS-B pair: 15 NM after entry', () => {
    const a = mk('A1', 'AAA60 W1 AAA68', 350, { surv: 'LB1' });
    const ok = mk('B1', 'AAA60 W1 AAA68', 350, { surv: 'LB1', at: T0 + 5 * MIN }); // 5 min at entry (4 req), ~40 NM after
    expect(run(a, ok).filter((c) => c.severity === 'LOS')).toHaveLength(0);
    const bad = mk('B2', 'AAA60 W1 AAA68', 350, { surv: 'LB1', at: T0 + 1.2 * MIN }); // ~10 NM
    const c = run(a, bad);
    expect(c[0].severity).toBe('LOS');
  });
  it('opposite direction at the same level is a conflict; 1000 ft resolves it', () => {
    const a = mk('A1', 'AAA60 W1 AAA68', 350);
    const b = mk('B1', 'AAA68 W1 AAA60', 350);
    expect(run(a, b)[0]).toMatchObject({ kind: 'OPPOSITE', severity: 'LOS' });
    const b2 = mk('B2', 'AAA68 W1 AAA60', 360);
    expect(run(a, b2)).toHaveLength(0);
  });
  it('a climb through another level is protected as a block', () => {
    const a = mk('A1', 'AAA60 W1 AAA68', 350);
    const b = mk('B1', 'AAA60 W1 AAA68', 370, { at: T0 + 3 * MIN });
    expect(run(a, b)).toHaveLength(0);
    applyCommand(a, { type: 'clear_level', callsign: 'A1', unit: 'VABX', level: 390 }, ctx, T0);
    expect(run(a, b)[0]?.severity).toBe('LOS');
    applyCommand(a, { type: 'level_reached', callsign: 'A1', unit: 'VABX' }, ctx, T0);
    expect(run(a, b)).toHaveLength(0);
  });
  it('PARAR-style crossing 3 min apart at the boundary point is flagged', () => {
    const a = mk('ABY405', 'AAA60 W1 AAA68', 350, { first: 'AAA64', at: T0 + 10 * MIN });
    const b = mk('BOX622', 'NNN19 N1 NNN11', 350, { first: 'AAA64', at: T0 + 13 * MIN });
    const c = run(a, b);
    expect(c[0]).toMatchObject({ severity: 'LOS', actualMin: 3 });
  });
  it('overdue report makes a marginal pair UNVERIFIED', () => {
    const a = mk('A1', 'AAA62 W1 AAA68', 350);
    const b = mk('B1', 'AAA62 W1 AAA68', 350, { at: T0 + 14 * MIN });
    b.units.VABX.contact = { at: T0 - 30 * MIN };
    b.units.VABX.nextReportFix = 'AAA62';
    b.estimates['AAA62'] = { time: T0 - 4 * MIN, source: 'PILOT', at: T0 - 30 * MIN };
    a.estimates['AAA62'] = { time: T0 + 8 * MIN, source: 'PILOT', at: T0 };
    const c = run(a, b);
    expect(c[0]?.severity).toBe('UNVERIFIED');
  });
});
