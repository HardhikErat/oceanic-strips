import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDIA_OCM_RULES, type NavData, type RawFlightPlan } from '@oceanic/core';
import { Clock } from '../src/clock.ts';
import type { ServerConfig } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import type { NavIndex } from '../src/nav/sectorFiles.ts';
import { ES_STALE_MS, Store } from '../src/store.ts';

// Synthetic nav data (no AeroNav data in tests): airway W1 along 15N, 60E–68E.
function navIndex(): NavIndex {
  const pts: [string, number][] = [['AAA60', 60], ['AAA62', 62], ['AAA64', 64], ['AAA66', 66], ['AAA68', 68]];
  const nav: NavData = { fixes: {}, airways: { W1: {} }, airports: {}, aircraftEngines: { B77W: 'J' } };
  pts.forEach(([n, lon], i) => {
    nav.fixes[n] = [{ lat: 15, lon }];
    nav.airways.W1[n] = { lat: 15, lon, next: [pts[i - 1]?.[0], pts[i + 1]?.[0]].filter(Boolean) as string[] };
  });
  return {
    nav,
    airspaces: [{ id: 'VABX', polygons: [[{ lat: 5, lon: 59 }, { lat: 25, lon: 59 }, { lat: 25, lon: 70 }, { lat: 5, lon: 70 }]] }],
    sectors: [],
    positions: {},
    positionsById: {},
    airac: '0000',
    map: { airways: [], fixes: [] },
  };
}

const cfg = {
  units: [{ id: 'VABX', name: 'Mumbai Oceanic', radioName: 'Mumbai Radio', esPositions: ['VABF_OC_CTR'], frequency: '132.600', hf: '8.864', sectorFile: 'VABF', ownerId: 'BOC', printLeadMin: 40, coordLeadMin: 30, passedRetentionMin: 5 }],
  rules: INDIA_OCM_RULES,
  liveForProcedural: false,
} as unknown as ServerConfig;

const db = { event: () => undefined } as unknown as Db;

const plan = (route: string): RawFlightPlan => ({
  callsign: 'TST1',
  aircraft: 'B77W/H-SDE1E2E3FGHIJ2/LB1',
  adep: 'XXXX',
  ades: 'YYYY',
  route,
  cruiseLevel: 35000,
  tas: 480,
  remarks: '',
});
const pos = (lon: number, time: number) => ({ lat: 15, lon, altitudeFt: 35000, groundSpeedKt: 480, time });
const esPoints = ['AAA60', 'AAA62', 'AAA64', 'AAA66', 'AAA68'].map((name, i) => ({ name, lat: 15, lon: 60 + 2 * i }));

describe('EuroScope / VATSIM feed hand-over', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 5, 12, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('ignores the feed for a flight EuroScope is sending (plan and position)', () => {
    const store = new Store(cfg, navIndex(), new Clock(), db);
    store.upsert(plan('AAA60 W1 AAA68'), pos(61, Date.now()), 'VATSIM');
    expect(store.flights.get('TST1')?.source).toBe('VATSIM');

    store.upsert(plan('AAA60 W1 AAA68'), pos(62, Date.now()), 'ES', esPoints);
    const f = store.flights.get('TST1')!;
    expect(f.source).toBe('ES');

    // 10 s later the feed reports an older position and an amended route: both ignored
    vi.advanceTimersByTime(10_000);
    store.upsert(plan('AAA60 W1 AAA66'), pos(61.5, Date.now()), 'VATSIM');
    expect(f.live?.lon).toBe(62);
    expect(f.fpl.route).toBe('AAA60 W1 AAA68');
    expect(f.source).toBe('ES');
  });

  it('hands the flight back to the feed once EuroScope stops sending it', () => {
    const store = new Store(cfg, navIndex(), new Clock(), db);
    store.upsert(plan('AAA60 W1 AAA68'), pos(62, Date.now()), 'ES', esPoints);
    const f = store.flights.get('TST1')!;

    // the feed keeps refreshing the flight, which must not keep it "EuroScope" forever
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(15_000);
      store.upsert(plan('AAA60 W1 AAA66'), pos(62.5 + i * 0.1, Date.now()), 'VATSIM');
    }
    expect(Date.now() - Date.UTC(2026, 10, 5, 12, 0)).toBeGreaterThan(ES_STALE_MS);
    expect(f.source).toBe('VATSIM');
    expect(f.fpl.route).toBe('AAA60 W1 AAA66');
    expect(f.live?.lon).toBeCloseTo(62.8);
  });

  it('uses the feed position while EuroScope has no correlated target', () => {
    const store = new Store(cfg, navIndex(), new Clock(), db);
    store.upsert(plan('AAA60 W1 AAA68'), undefined, 'ES', esPoints);
    const f = store.flights.get('TST1')!;
    vi.advanceTimersByTime(5_000);
    store.upsert(plan('AAA60 W1 AAA66'), pos(63, Date.now()), 'VATSIM');
    expect(f.live?.lon).toBe(63); // position from the feed…
    expect(f.fpl.route).toBe('AAA60 W1 AAA68'); // …but the plan stays EuroScope's
    expect(f.source).toBe('ES');
  });
});
