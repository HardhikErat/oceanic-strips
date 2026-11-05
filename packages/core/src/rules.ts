// Separation rule set. Every number cites the Indian document it comes from.
// The default is the India vACC Oceanic Control Manual v1.0 (OCM) plus the
// India–Oman Letter of Agreement (AAI Mumbai OCC – PACA Muscat ACC, eff. 15 Feb 2016).

export interface MachRow {
  /** preceding aircraft faster than following by at least this Mach */
  machDiff: number;
  minutes: number;
}

export interface LetterOfAgreement {
  id: string;
  name: string;
  /** Indian unit(s) the LoA applies to */
  units: string[];
  neighbour: string;
  /** Transfer of control points on the common boundary */
  tcps: string[];
  sameDirectionMin: number;
  machTable: MachRow[];
  source: string;
}

export interface SeparationRules {
  id: string;
  name: string;
  vertical: { minFt: number; upperThresholdFl: number; upperMinFt: number; source: string };
  lateral: { adsbNm: number; otherNm: number; source: string };
  longitudinal: {
    /** relative track angle below which tracks are "same track" */
    sameTrackMaxAngle: number;
    /** relative track angle above which tracks are "opposite direction" */
    oppositeMinAngle: number;
    adsb: { entryMin: number; thereafterNm: number; source: string };
    other: { sameTrackMin: number; crossingMin: number; source: string };
    mnt: { table: MachRow[]; requireTurbojet: boolean; requireAssignedMach: boolean; source: string };
    opposite: { windowMin: number; source: string; note: string };
  };
  warnBufferMin: number;
  warnBufferNm: number;
  /** Item 10b codes that make an aircraft "ADS-B equipped" */
  adsbSurveillanceCodes: string[];
  /** minutes after an ETO before a procedural report is overdue */
  overdueMin: number;
  /** look-ahead for the probe, minutes */
  horizonMin: number;
  loas: LetterOfAgreement[];
}

const MNT_TABLE: MachRow[] = [
  { machDiff: 0.06, minutes: 5 },
  { machDiff: 0.05, minutes: 6 },
  { machDiff: 0.04, minutes: 7 },
  { machDiff: 0.03, minutes: 8 },
  { machDiff: 0.02, minutes: 9 },
];

export const INDIA_OCM_RULES: SeparationRules = {
  id: 'india-ocm-v1',
  name: 'India vACC Oceanic Control Manual v1.0',
  vertical: {
    minFt: 1000,
    upperThresholdFl: 410,
    upperMinFt: 2000,
    source: 'OCM 6.1 (all aircraft FL290–FL410 assumed RVSM on VATSIM)',
  },
  lateral: { adsbNm: 19, otherNm: 60, source: 'OCM 6.2 (SLOP not considered, OCM 6.2.1)' },
  longitudinal: {
    sameTrackMaxAngle: 45,
    oppositeMinAngle: 135,
    adsb: { entryMin: 4, thereafterNm: 15, source: 'OCM 6.3.1 (ADS-B aircraft)' },
    other: { sameTrackMin: 10, crossingMin: 15, source: 'OCM 6.3.1 (other aircraft)' },
    mnt: {
      table: MNT_TABLE,
      requireTurbojet: true,
      requireAssignedMach: true,
      source: 'OCM 6.3.2 Mach Number Technique',
    },
    opposite: {
      windowMin: 10,
      source: 'Opposite direction – not specified in OCM',
      note: 'Vertical separation required 10 min either side of the estimated passing time. Confirm with India vACC.',
    },
  },
  warnBufferMin: 2,
  warnBufferNm: 5,
  adsbSurveillanceCodes: ['B1', 'B2'],
  overdueMin: 3,
  horizonMin: 180,
  loas: [
    {
      id: 'india-oman',
      name: 'LoA India (AAI Mumbai OCC) – Oman (PACA Muscat ACC)',
      units: ['VABX'],
      neighbour: 'OOMM',
      tcps: [],
      sameDirectionMin: 10,
      machTable: MNT_TABLE,
      source: 'LoA India–Oman Para G 1.1',
    },
  ],
};

/** Minutes required for a Mach difference (preceding minus following) per a table; 10 if none applies. */
export function machTableMinutes(table: MachRow[], diff: number, fallback: number): number {
  const d = Math.round(diff * 100) / 100;
  for (const row of table) if (d >= row.machDiff - 1e-9) return row.minutes;
  return fallback;
}

/** Vertical minimum in FL units (10 = 1000 ft) for two level bands. */
export function verticalMinFl(rules: SeparationRules, highestFl: number): number {
  const ft = highestFl > rules.vertical.upperThresholdFl ? rules.vertical.upperMinFt : rules.vertical.minFt;
  return ft / 100;
}
