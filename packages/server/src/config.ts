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
  sectorFiles: Record<string, string>;
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
 * Sector file folder; a trailing "*" picks the newest matching folder, so dropping a new
 * AIRAC install next to the old one is enough (AeroNav folder names sort by date).
 */
function resolveSectorDir(p: string): string {
  const full = abs(p);
  if (!full.includes('*')) return full;
  const dir = path.dirname(full);
  const prefix = path.basename(full).replace(/\*.*$/, '');
  if (!fs.existsSync(dir)) return full;
  const matches = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  return matches.length ? path.join(dir, matches[matches.length - 1]) : full;
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
    sectorFiles: Object.fromEntries(Object.entries(raw.sectorFiles as Record<string, string>).map(([k, v]) => [k, resolveSectorDir(v)])),
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
