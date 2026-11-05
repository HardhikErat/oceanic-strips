// Shared data model for server, web board and plugin bridge.
import type { LatLon } from './geo.ts';

export type Category = 'ADSB' | 'OTHER';
export type EstimateSource = 'ATO' | 'PILOT' | 'COORD' | 'CTRL' | 'SYSTEM';
export type DataSource = 'VATSIM' | 'ES' | 'SIM' | 'MANUAL';

export interface SpeedSpec {
  kind: 'M' | 'N' | 'K';
  /** Mach as decimal (0.83), N in knots, K in km/h */
  value: number;
}

export interface FlightPlan {
  callsign: string;
  aircraftType: string;
  wake: string;
  /** Item 10a, e.g. SDE1E2E3FGHIJ2J3J4J5M1RWXYZ */
  equipment: string;
  /** Item 10b, e.g. LB1D1 */
  surveillance: string;
  flightRules: string;
  /** Item 8b type of flight (S scheduled, N non-scheduled, G general, M military, X other) */
  typeOfFlight: string;
  adep: string;
  ades: string;
  altn: string;
  /** Item 15 exactly as filed */
  route: string;
  /** Requested flight level (FL, hundreds of feet) */
  rfl: number;
  /** Filed TAS in knots */
  tas: number;
  /** Item 18 / remarks */
  item18: string;
  squawk: string;
  /** J = jet, T = turboprop, P = piston (from ICAO aircraft list) */
  engineType?: string;
  /** Date of flight DDMM (from DOF/ or derived) */
  dof?: string;
}

export interface RoutePoint extends LatLon {
  name: string;
  /** ATS route used to arrive at this point (undefined for DCT / first point) */
  airway?: string;
  speed?: SpeedSpec;
  levelFl?: number;
  isAirport?: boolean;
  isCoordinate?: boolean;
  /** Cumulative great-circle distance from route start, NM */
  distNm: number;
}

export interface TimedValue {
  /** epoch ms UTC */
  time: number;
  source: EstimateSource;
  /** when the value was entered, epoch ms */
  at: number;
  by?: string;
}

export interface LevelState {
  /** Cleared flight level (FL) */
  cleared: number;
  /** Level the aircraft is leaving while a change is in progress */
  previous?: number;
  changeStartedAt?: number;
  /** Controller asked for "report reaching" */
  reportReaching?: boolean;
  /** Level confirmed by pilot/ADS-B (tick in Box B) */
  confirmed?: boolean;
  /** Block level clearance [lower, upper] */
  block?: [number, number];
}

export interface PositionReport {
  fix: string;
  time: number;
  level?: number;
  mach?: number;
  nextFix?: string;
  nextTime?: number;
  thenFix?: string;
  receivedAt: number;
  by?: string;
  raw?: string;
}

export type UnitPhase = 'PENDING' | 'ACTIVE' | 'HANDED_OFF';

export interface StripMarks {
  /** handwritten symbols, e.g. "C○", "✓", "✗", "R" */
  symbols?: string[];
  /** Box G free text */
  text?: string;
  levelTick?: boolean;
}

export interface UnitState {
  unit: string;
  phase: UnitPhase;
  printedAt: number;
  /** route indices that get a fix strip in this unit, in route order */
  pointIndices: number[];
  entryFix: string;
  exitFix: string;
  /** Next unit after exit (position callsign or unit id), resolved or entered by controller */
  nextUnit?: string;
  prevUnit?: string;
  estimateIn?: { fix: string; time: number; from: string; at: number; by?: string };
  estimateOut?: { fix: string; time: number; to: string; at: number; by?: string };
  handoff?: { to: string; freq?: string; at: number; by?: string };
  contact?: {
    at: number;
    adsbLevel?: boolean;
    adsbMach?: boolean;
    selcal?: boolean;
  };
  nextReportFix?: string;
  marks: Record<string, StripMarks>;
  /** ETOs as printed on the strips (Box A), to show revisions struck through */
  printedEtos?: Record<string, number>;
}

export interface Restriction {
  fix: string;
  kind: 'AT_OR_BEFORE' | 'AT_OR_AFTER' | 'AT';
  time: number;
  at: number;
}

export interface Deviation {
  side: 'L' | 'R' | 'LR';
  nm: number;
  since: number;
}

export interface HistoryEntry {
  at: number;
  by?: string;
  unit?: string;
  kind: string;
  text: string;
}

export interface LivePosition extends LatLon {
  altitudeFt: number;
  groundSpeedKt: number;
  heading?: number;
  time: number;
}

export interface Flight {
  callsign: string;
  fpl: FlightPlan;
  route: RoutePoint[];
  unresolved: string[];
  category: Category;
  categoryAuto: Category;
  categoryOverridden: boolean;
  turbojet: boolean;
  selcal?: string;
  pbn?: string;
  level: LevelState;
  /** Assigned/confirmed Mach, decimal (0.83) */
  mach?: number;
  /** Explicit (non-calculated) estimates keyed by fix name */
  estimates: Record<string, TimedValue>;
  /** Actual times over keyed by fix name */
  atos: Record<string, TimedValue>;
  reports: PositionReport[];
  restrictions: Restriction[];
  deviation?: Deviation;
  emergency?: boolean;
  units: Record<string, UnitState>;
  live?: LivePosition;
  /** route index the live position is heading to (for ADS-B system ATOs) */
  liveNextIndex?: number;
  source: DataSource;
  lastSeen: number;
  history: HistoryEntry[];
}

export type ConflictKind = 'SAME' | 'CROSSING' | 'OPPOSITE';
export type ConflictSeverity = 'LOS' | 'WARN' | 'UNVERIFIED';

export interface RuleRef {
  id: string;
  text: string;
  source: string;
}

export interface Conflict {
  id: string;
  a: string;
  b: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  /** unit(s) whose airspace contains the conflict location */
  units: string[];
  location: LatLon & { fix?: string };
  /** time of minimum separation, epoch ms */
  time: number;
  actualMin?: number;
  actualNm?: number;
  requiredMin?: number;
  requiredNm?: number;
  levelA: string;
  levelB: string;
  rule: RuleRef;
  /** fix strips to highlight per callsign */
  fixes: Record<string, string[]>;
  note?: string;
}

export interface CoordEntry {
  at: number;
  from: string;
  to: string;
  callsign: string;
  kind: 'ESTIMATE' | 'HANDOFF' | 'REVISION' | 'FREE';
  text: string;
  by?: string;
}

export interface RadioMessage {
  at: number;
  unit: string;
  callsign: string;
  text: string;
  /** structured payload a controller can copy onto the strips with one click */
  report?: Omit<PositionReport, 'receivedAt'>;
  kind: 'FIRST_CONTACT' | 'POSITION' | 'REACHING' | 'REQUEST' | 'SELCAL' | 'OTHER';
  handled?: boolean;
  id: string;
}
