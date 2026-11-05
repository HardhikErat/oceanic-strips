import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDIA_OCM_RULES, type SeparationRules } from '@oceanic/core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface UnitConfig {
  id: string;
  name: string;
  radioName: string;
  esPositions: string[];
  frequency: string;
  hf: string;
  hfSecondary?: string[];
  sectorFile: string;
  ownerId: string;
  printLeadMin: number;
  coordLeadMin: number;
  passedRetentionMin: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** folders searched (recursively) for sector files; names do not matter */
  sectorRoots: string[];
  units: UnitConfig[];
  rules: SeparationRules;
  dataSource: 'vatsim' | 'sim' | 'none';
  vatsimFeedUrl: string;
  vatsimPollSeconds: number;
  scenario?: string;
  auth: {
    mode: 'local' | 'vatsim';
    vatsim: { authBase: string; clientId: string; clientSecret: string; redirectUri: string };
  };
  pluginToken: string;
  liveForProcedural: boolean;
  trainingAutoReports: boolean;
  timeScale?: number;
}

const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

/**
 * Folders to search for sector files. `sectorFilesDir` (default "Sector files") may be a
 * string or a list. Older configs with a `sectorFiles` map of paths/globs still work: the
 * folder part of each entry is searched.
 */
function sectorRootsFrom(raw: { sectorFilesDir?: string | string[]; sectorFiles?: Record<string, string> }): string[] {
  const roots = new Set<string>();
  const dirs = raw.sectorFilesDir ?? (raw.sectorFiles ? [] : 'Sector files');
  for (const d of Array.isArray(dirs) ? dirs : [dirs]) roots.add(abs(d));
  for (const v of Object.values(raw.sectorFiles ?? {})) {
    const full = abs(v);
    roots.add(full.includes('*') ? path.dirname(full) : full);
  }
  return [...roots];
}

/** AIRAC cycle in force on a date (28-day cycles; 2401 became effective 25 Jan 2024). */
export function currentAirac(at = Date.now()): string {
  let eff = Date.UTC(2024, 0, 25);
  let year = 2024;
  let n = 1;
  const DAY = 86_400_000;
  while (eff + 28 * DAY <= at) {
    eff += 28 * DAY;
    const y = new Date(eff).getUTCFullYear();
    if (y !== year) { year = y; n = 1; } else n++;
  }
  return `${String(year).slice(2)}${String(n).padStart(2, '0')}`;
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k.startsWith('_')) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function loadConfig(argv: string[]): ServerConfig {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = abs(arg('config') ?? 'config/server.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const units: UnitConfig[] = (raw.units as string[]).map((u) => JSON.parse(fs.readFileSync(abs(u), 'utf8')));
  let rules = INDIA_OCM_RULES;
  if (raw.rules && fs.existsSync(abs(raw.rules))) rules = deepMerge(INDIA_OCM_RULES, JSON.parse(fs.readFileSync(abs(raw.rules), 'utf8')));
  const cfg: ServerConfig = {
    ...raw,
    dataDir: abs(raw.dataDir ?? 'data/local'),
    sectorRoots: sectorRootsFrom(raw),
    units,
    rules,
  };
  const src = arg('source');
  if (src === 'vatsim' || src === 'sim' || src === 'none') cfg.dataSource = src;
  const sc = arg('scenario');
  if (sc) { cfg.scenario = abs(sc); if (!src) cfg.dataSource = 'sim'; }
  if (arg('port')) cfg.port = Number(arg('port'));
  if (arg('host')) cfg.host = arg('host')!;
  if (arg('time-scale')) cfg.timeScale = Number(arg('time-scale'));
  if (process.env.VATSIM_CLIENT_ID) {
    cfg.auth.mode = 'vatsim';
    cfg.auth.vatsim.clientId = process.env.VATSIM_CLIENT_ID;
    cfg.auth.vatsim.clientSecret = process.env.VATSIM_CLIENT_SECRET ?? '';
    if (process.env.VATSIM_REDIRECT_URI) cfg.auth.vatsim.redirectUri = process.env.VATSIM_REDIRECT_URI;
    if (process.env.VATSIM_AUTH_BASE) cfg.auth.vatsim.authBase = process.env.VATSIM_AUTH_BASE;
  }
  if (process.env.PLUGIN_TOKEN) cfg.pluginToken = process.env.PLUGIN_TOKEN;
  return cfg;
}
