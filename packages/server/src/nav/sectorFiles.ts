// Reads the controller's own installed EuroScope sector files (VABF / VOMF / VECF) at runtime.
// Files are found anywhere under the configured folder and identified by their contents,
// so file and folder names do not matter.
//
// AeroNav notice: the sector files are licensed for personal, non-commercial use and
// must not be redistributed. This module only reads them on the controller's machine;
// the parsed cache lives in data/local/ (git-ignored) and is never published.
import fs from 'node:fs';
import path from 'node:path';
import { parseEsCoord, type LatLon, type NavData, type UnitAirspace, type AirwayNode } from '@oceanic/core';

export interface EsPosition {
  callsign: string;
  radioName: string;
  frequency: string;
  id: string;
  prefix: string;
  suffix: string;
}

export interface EsSector {
  name: string;
  file: string;
  owners: string[];
  floor: number;
  ceiling: number;
  polygon: LatLon[];
}

export interface NavIndex {
  nav: NavData;
  airspaces: UnitAirspace[];
  sectors: EsSector[];
  positions: Record<string, EsPosition>;
  /** position id -> position */
  positionsById: Record<string, EsPosition>;
  airac: string;
  /** data for the situation display: airways near the oceanic airspace */
  map: { airways: { name: string; points: [number, number][] }[]; fixes: { name: string; lat: number; lon: number }[] };
  /** set-up problems to show to the controller (missing files, no oceanic sectors …) */
  problems: string[];
  /** sector files in use, per FIR */
  files: { fir: string; ese: string; airac: string }[];
}

export interface UnitSectorSpec {
  id: string;
  /** which sector file (VABF / VOMF) defines this unit */
  sectorFile: string;
  /** ESE position id that owns the oceanic sectors first (e.g. BOC, COC) */
  ownerId: string;
  /** position callsigns of the unit (e.g. VABF_OC_CTR); their ESE id is used if it differs from ownerId */
  esPositions?: string[];
}

const REGION = { minLat: -45, maxLat: 42, minLon: 28, maxLon: 118 };
const inRegion = (lat: number, lon: number) => lat >= REGION.minLat && lat <= REGION.maxLat && lon >= REGION.minLon && lon <= REGION.maxLon;

const readLatin1 = (p: string) => fs.readFileSync(p, 'latin1');
const lines = (s: string) => s.split(/\r?\n/);

export interface SectorFileSet {
  /** FIR the file belongs to, from its contents (e.g. VABF) */
  fir: string;
  ese: string;
  sct?: string;
  navDir?: string;
  icaoDir?: string;
  airac: string;
}

// folders inside an AeroNav install that never hold sector or nav files
const SKIP_DIRS = new Set(['plugins', 'asr', 'sounds', 'settings', 'alias', 'grp']);

function walk(dir: string, depth: number, out: { eses: string[]; navDirs: string[]; icaoDirs: string[] }) {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const low = e.name.toLowerCase();
    if (e.isDirectory()) {
      if (low === 'navdata' && fs.existsSync(path.join(p, 'airway.txt'))) out.navDirs.push(p);
      else if (low === 'icao' && fs.existsSync(path.join(p, 'ICAO_Aircraft.txt'))) out.icaoDirs.push(p);
      else if (!SKIP_DIRS.has(low)) walk(p, depth + 1, out);
    } else if (low.endsWith('.ese')) out.eses.push(p);
  }
}

/**
 * FIR a sector file belongs to, read from its contents so file and folder names do not
 * matter: the AeroNav "File-Publisher: Mumbai - VABF" line, else the FIR prefix used by
 * most of its SECTOR definitions.
 */
export function eseHomeFir(text: string): string | undefined {
  const pub = /File-Publisher:[^\n]*?-\s*([A-Z]{4})\b/.exec(text);
  if (pub) return pub[1];
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/^SECTOR:([A-Z]{4})\u00B7/gm)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

const isUnder = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

/** Find sector files anywhere below the given folders, grouped by FIR (newest AIRAC wins). */
export function discoverSectorFiles(roots: string[]): { byFir: Record<string, SectorFileSet>; all: SectorFileSet[] } {
  const found = { eses: [] as string[], navDirs: [] as string[], icaoDirs: [] as string[] };
  for (const r of roots) if (fs.existsSync(r)) walk(r, 0, found);
  const all: SectorFileSet[] = [];
  for (const ese of found.eses) {
    let text: string;
    try { text = fs.readFileSync(ese, 'latin1'); } catch { continue; }
    const fir = eseHomeFir(text);
    if (!fir) continue;
    const dir = path.dirname(ese);
    const base = path.basename(ese, path.extname(ese));
    const scts = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sct'));
    const sct = scts.find((f) => path.basename(f, path.extname(f)) === base) ?? scts[0];
    const nearest = (list: string[]) => list.filter((d) => isUnder(d, dir)).sort((a, b) => a.length - b.length)[0];
    all.push({
      fir,
      ese,
      sct: sct ? path.join(dir, sct) : undefined,
      navDir: nearest(found.navDirs),
      icaoDir: nearest(found.icaoDirs),
      airac: /AIRAC\s+(\d{4})/.exec(text)?.[1] ?? '',
    });
  }
  const byFir: Record<string, SectorFileSet> = {};
  for (const f of all) {
    const cur = byFir[f.fir];
    if (!cur || f.airac > cur.airac || (f.airac === cur.airac && fs.statSync(f.ese).mtimeMs > fs.statSync(cur.ese).mtimeMs)) byFir[f.fir] = f;
  }
  // fall back to any NavData / ICAO folder found if a file has none of its own
  for (const f of Object.values(byFir)) {
    f.navDir ??= found.navDirs[0];
    f.icaoDir ??= found.icaoDirs[0];
  }
  return { byFir, all };
}

function parseEse(text: string, file: string) {
  const positions: EsPosition[] = [];
  const sectorLines = new Map<string, LatLon[]>();
  const sectors: { name: string; owners: string[]; borders: string[]; floor: number; ceiling: number }[] = [];
  let section = '';
  let curLine: string | null = null;
  let curSector: (typeof sectors)[number] | null = null;
  const circleLines: { id: string; center: string[]; radius: number }[] = [];
  for (const raw of lines(text)) {
    const l = raw.trim();
    if (!l || l.startsWith(';')) continue;
    if (l.startsWith('[')) { section = l; continue; }
    if (section === '[POSITIONS]') {
      const p = l.split(':');
      if (p.length >= 7) positions.push({ callsign: p[0], radioName: p[1], frequency: p[2], id: p[3], prefix: p[5], suffix: p[6] });
      continue;
    }
    if (section !== '[AIRSPACE]') continue;
    const parts = l.split(':');
    switch (parts[0]) {
      case 'SECTORLINE':
        curLine = parts[1];
        sectorLines.set(curLine, []);
        curSector = null;
        break;
      case 'CIRCLE_SECTORLINE':
        // CIRCLE_SECTORLINE:id:lat:lon:radius  or  CIRCLE_SECTORLINE:id:FIX:radius
        circleLines.push({ id: parts[1], center: parts.slice(2, parts.length - 1), radius: Number(parts[parts.length - 1]) });
        curLine = null;
        break;
      case 'COORD':
        if (curLine) sectorLines.get(curLine)!.push({ lat: parseEsCoord(parts[1]), lon: parseEsCoord(parts[2]) });
        break;
      case 'SECTOR':
        curLine = null;
        curSector = { name: parts[1], owners: [], borders: [], floor: Number(parts[2]) || 0, ceiling: Number(parts[3]) || 99999 };
        sectors.push(curSector);
        break;
      case 'OWNER':
        if (curSector) curSector.owners = parts.slice(1);
        break;
      case 'BORDER':
        if (curSector) curSector.borders = parts.slice(1).filter(Boolean);
        break;
    }
  }
  for (const c of circleLines) {
    if (c.center.length === 2) {
      const lat = parseEsCoord(c.center[0]), lon = parseEsCoord(c.center[1]);
      const pts: LatLon[] = [];
      for (let a = 0; a < 360; a += 10) {
        const r = c.radius / 60;
        pts.push({ lat: lat + r * Math.cos((a * Math.PI) / 180), lon: lon + (r * Math.sin((a * Math.PI) / 180)) / Math.cos((lat * Math.PI) / 180) });
      }
      sectorLines.set(c.id, pts);
    }
  }
  const out: EsSector[] = [];
  for (const s of sectors) {
    const poly = chainBorders(s.borders.map((b) => sectorLines.get(b) ?? []).filter((x) => x.length));
    if (poly.length >= 3) out.push({ name: s.name, file, owners: s.owners, floor: s.floor, ceiling: s.ceiling, polygon: poly });
  }
  return { positions, sectors: out };
}

/** Join sector lines end-to-end into one closed ring (reversing lines where needed). */
function chainBorders(segs: LatLon[][]): LatLon[] {
  if (!segs.length) return [];
  const d = (a: LatLon, b: LatLon) => Math.hypot(a.lat - b.lat, a.lon - b.lon);
  const remaining = segs.map((s) => [...s]);
  const ring = remaining.shift()!;
  const nearestTo = (p: LatLon) => {
    let bd = Infinity;
    for (const s of remaining) bd = Math.min(bd, d(p, s[0]), d(p, s[s.length - 1]));
    return bd;
  };
  // orient the first line so that its end connects to the next line
  if (remaining.length && nearestTo(ring[0]) < nearestTo(ring[ring.length - 1])) ring.reverse();
  while (remaining.length) {
    const end = ring[ring.length - 1];
    let bi = 0, rev = false, bd = Infinity;
    remaining.forEach((s, i) => {
      const ds = d(end, s[0]), de = d(end, s[s.length - 1]);
      if (ds < bd) { bd = ds; bi = i; rev = false; }
      if (de < bd) { bd = de; bi = i; rev = true; }
    });
    const s = remaining.splice(bi, 1)[0];
    if (rev) s.reverse();
    for (const p of s) if (d(p, ring[ring.length - 1]) > 1e-7) ring.push(p);
  }
  if (ring.length > 2 && d(ring[0], ring[ring.length - 1]) < 1e-7) ring.pop();
  return ring;
}

function parseNavData(navDir: string, nav: NavData, mapAirways: Map<string, Set<string>>) {
  // isec.txt: NAME lat lon type
  for (const l of lines(readLatin1(path.join(navDir, 'isec.txt')))) {
    if (!l || l[0] === ';') continue;
    const p = l.split('\t');
    if (p.length < 3) continue;
    const lat = Number(p[1]), lon = Number(p[2]);
    if (!inRegion(lat, lon)) continue;
    (nav.fixes[p[0]] ??= []).push({ lat, lon });
  }
  // icao.txt airports
  for (const l of lines(readLatin1(path.join(navDir, 'icao.txt')))) {
    if (!l || l[0] === ';') continue;
    const p = l.split('\t');
    if (p.length < 3) continue;
    const lat = Number(p[1]), lon = Number(p[2]);
    if (inRegion(lat, lon) || /^(O|V|W|F|H|Y|Z)/.test(p[0])) nav.airports[p[0]] = { lat, lon };
  }
  // airway.txt: FIX lat lon ? AWY ? PREV plat plon ? Y NEXT nlat nlon ? Y
  for (const l of lines(readLatin1(path.join(navDir, 'airway.txt')))) {
    if (!l || l[0] === ';') continue;
    const p = l.split('\t');
    if (p.length < 12) continue;
    const lat = Number(p[1]), lon = Number(p[2]);
    if (!inRegion(lat, lon)) continue;
    const aw = p[4];
    const g = (nav.airways[aw] ??= {});
    const node: AirwayNode = (g[p[0]] ??= { lat, lon, next: [] });
    for (const [n, la, lo] of [[p[6], p[7], p[8]], [p[11], p[12], p[13]]]) {
      if (!n) continue;
      if (!node.next.includes(n)) node.next.push(n);
      if (!g[n] && la && lo && inRegion(Number(la), Number(lo))) g[n] = { lat: Number(la), lon: Number(lo), next: [p[0]] };
      else if (g[n] && !g[n].next.includes(p[0])) g[n].next.push(p[0]);
    }
    if (!(p[0] in nav.fixes)) nav.fixes[p[0]] = [{ lat, lon }];
    const set = mapAirways.get(aw) ?? new Set();
    set.add(p[0]);
    mapAirways.set(aw, set);
  }
}

function parseAircraft(icaoDir: string, nav: NavData) {
  nav.aircraftEngines ??= {};
  for (const l of lines(readLatin1(path.join(icaoDir, 'ICAO_Aircraft.txt')))) {
    if (!l || l[0] === ';') continue;
    const p = l.split('\t');
    // TYPE  "HL2J" = wake, L(and)/S(ea)/A(mph)/H(eli), engines, engine type
    if (p.length >= 2 && p[1].length >= 4) nav.aircraftEngines[p[0]] = p[1][3];
  }
}

function sctFixes(sct: string, nav: NavData) {
  let section = '';
  for (const raw of lines(readLatin1(sct))) {
    const l = raw.trim();
    if (!l || l.startsWith(';')) continue;
    if (l.startsWith('[')) { section = l; continue; }
    if (section === '[FIXES]' || section === '[VOR]' || section === '[NDB]') {
      const p = l.split(/\s+/);
      const latS = p.find((x) => /^[NS]\d{3}\./.test(x));
      const lonS = p.find((x) => /^[EW]\d{3}\./.test(x));
      if (!latS || !lonS) continue;
      const lat = parseEsCoord(latS), lon = parseEsCoord(lonS);
      if (!inRegion(lat, lon)) continue;
      const list = (nav.fixes[p[0]] ??= []);
      if (!list.some((q) => Math.abs(q.lat - lat) < 0.01 && Math.abs(q.lon - lon) < 0.01)) list.push({ lat, lon });
    } else if (section === '[AIRPORT]') {
      const p = l.split(/\s+/);
      if (p.length >= 4) nav.airports[p[0]] ??= { lat: parseEsCoord(p[2]), lon: parseEsCoord(p[3]) };
    }
  }
}

export function loadSectorFiles(roots: string[], units: UnitSectorSpec[], cacheFile: string): NavIndex {
  const found = discoverSectorFiles(roots).byFir;
  const stamp = JSON.stringify(
    Object.values(found).flatMap((f) => [f.ese, f.sct, f.navDir && path.join(f.navDir, 'airway.txt')].filter(Boolean).map((p) => `${p}:${fs.statSync(p!).mtimeMs}`)),
  ) + JSON.stringify(units);
  if (fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.stamp === stamp) return c.index as NavIndex;
    } catch { /* rebuild */ }
  }

  const nav: NavData = { fixes: {}, airways: {}, airports: {}, aircraftEngines: {} };
  const sectors: EsSector[] = [];
  const positions: Record<string, EsPosition> = {};
  const positionsById: Record<string, EsPosition> = {};
  const mapAirways = new Map<string, Set<string>>();
  let navLoaded = false;
  const sectorsByFile: Record<string, EsSector[]> = {};
  const positionsByFile: Record<string, EsPosition[]> = {};
  const problems: string[] = [];
  const where = roots.map((r) => `"${r}"`).join(', ');
  for (const u of units) {
    const f = found[u.sectorFile];
    if (!f) problems.push(`${u.id}: no ${u.sectorFile} sector file (.ese) found under ${where}. Put the AeroNav ${u.sectorFile} install there – any folder name works.`);
    else if (!f.navDir) problems.push(`${u.sectorFile}: NavData folder not found – airways and fixes may be incomplete.`);
  }
  // the AIRAC shown is the oldest of the files the units use, so an outdated one is noticed
  const unitAiracs = [...new Set(units.map((u) => found[u.sectorFile]?.airac).filter(Boolean) as string[])].sort();
  const airac = unitAiracs[0] ?? '';
  if (unitAiracs.length > 1) problems.push(`Sector files are from different AIRACs (${unitAiracs.join(', ')}). Update them all to the same cycle.`);

  for (const [key, f] of Object.entries(found)) {
    if (f.ese) {
      const eseText = readLatin1(f.ese);
      const { positions: pos, sectors: sec } = parseEse(eseText, key);
      for (const p of pos) {
        positions[p.callsign] ??= p;
        // ids clash across files (e.g. COC vs COCE) – keep the file's own definition first
        if (!positionsById[p.id] || p.prefix === key) positionsById[p.id] = p;
      }
      sectorsByFile[key] = sec;
      positionsByFile[key] = pos;
      for (const s of sec) if (!sectors.some((x) => x.name === s.name)) sectors.push(s);
    }
    if (f.navDir && !navLoaded) {
      parseNavData(f.navDir, nav, mapAirways);
      navLoaded = true;
    }
    if (f.icaoDir && !Object.keys(nav.aircraftEngines!).length) parseAircraft(f.icaoDir, nav);
    if (f.sct) sctFixes(f.sct, nav);
  }

  const airspaces: UnitAirspace[] = units.map((u) => {
    // the oceanic position's ESE id can change between AIRACs: take it from the position
    // callsign in the same file, with the configured id as a fallback
    const ids = new Set([u.ownerId]);
    for (const p of positionsByFile[u.sectorFile] ?? []) if (u.esPositions?.includes(p.callsign)) ids.add(p.id);
    const own = (sectorsByFile[u.sectorFile] ?? []).filter((s) => ids.has(s.owners[0]));
    if (found[u.sectorFile]?.ese && !own.length) {
      problems.push(`${u.id}: no oceanic sectors in the ${u.sectorFile} sector file (looked for sectors owned by ${[...ids].join('/')}). No strips can be produced for ${u.id}.`);
    }
    return { id: u.id, polygons: own.map((s) => s.polygon) };
  });

  // situation display: airways with at least one node inside / near Indian oceanic airspace
  const bboxRaw = airspaces.flatMap((a) => a.polygons.flat());
  const bbox = bboxRaw.length ? bboxRaw : [{ lat: -10, lon: 55 }, { lat: 25, lon: 100 }];
  const minLat = Math.min(...bbox.map((p) => p.lat)) - 4, maxLat = Math.max(...bbox.map((p) => p.lat)) + 4;
  const minLon = Math.min(...bbox.map((p) => p.lon)) - 4, maxLon = Math.max(...bbox.map((p) => p.lon)) + 4;
  const inBox = (p: LatLon) => p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon;
  const mapOut: NavIndex['map'] = { airways: [], fixes: [] };
  const fixSet = new Set<string>();
  for (const [aw, g] of Object.entries(nav.airways)) {
    if (!/^[A-Z]\d{1,3}$|^U?[A-Z]\d{1,3}$/.test(aw)) continue;
    const seen = new Set<string>();
    for (const [name, node] of Object.entries(g)) {
      if (!inBox(node)) continue;
      for (const n of node.next) {
        const key = [name, n].sort().join('|');
        const o = g[n];
        if (!o || seen.has(key) || !inBox(o)) continue;
        seen.add(key);
        mapOut.airways.push({ name: aw, points: [[node.lat, node.lon], [o.lat, o.lon]] });
        fixSet.add(name); fixSet.add(n);
      }
    }
  }
  for (const n of fixSet) {
    const p = nav.fixes[n]?.find(inBox);
    if (p && !/^\d/.test(n)) mapOut.fixes.push({ name: n, lat: p.lat, lon: p.lon });
  }

  const files = Object.values(found).map((f) => ({ fir: f.fir, ese: f.ese, airac: f.airac }));
  const index: NavIndex = { nav, airspaces, sectors, positions, positionsById, airac, map: mapOut, problems, files };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ stamp, index }));
  return index;
}
