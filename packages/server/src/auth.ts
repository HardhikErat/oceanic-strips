// Authentication: VATSIM Connect (OAuth2) when configured, otherwise a local login
// (CID + name, no password) intended for a server bound to localhost / training.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config.ts';
import type { Db } from './db.ts';

export interface SessionUser {
  cid: string;
  name: string;
  rating: number | null;
}

const COOKIE = 'ios_session';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export class Auth {
  private states = new Map<string, number>();
  constructor(private cfg: ServerConfig, private db: Db) {}

  user(req: IncomingMessage): SessionUser | undefined {
    const t = parseCookies(req)[COOKIE];
    if (!t) return undefined;
    return this.db.session(t) ?? undefined;
  }

  private setSession(res: ServerResponse, u: SessionUser, extraHeaders: Record<string, string> = {}, redirect?: string) {
    const token = crypto.randomBytes(24).toString('hex');
    this.db.saveSession(token, u.cid, u.name, u.rating);
    const cookie = `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`;
    if (redirect) {
      res.writeHead(302, { 'Set-Cookie': cookie, Location: redirect, ...extraHeaders });
      res.end();
    } else json(res, 200, { ok: true, user: u }, { 'Set-Cookie': cookie, ...extraHeaders });
  }

  /** Returns true if the request was handled. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const v = this.cfg.auth.vatsim;
    if (url.pathname === '/auth/config') {
      json(res, 200, { mode: this.cfg.auth.mode });
      return true;
    }
    if (url.pathname === '/auth/me') {
      const u = this.user(req);
      json(res, u ? 200 : 401, u ? { user: u } : { error: 'not logged in' });
      return true;
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const t = parseCookies(req)[COOKIE];
      if (t) this.db.deleteSession(t);
      json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      return true;
    }
    if (url.pathname === '/auth/local' && req.method === 'POST') {
      if (this.cfg.auth.mode !== 'local') { json(res, 403, { error: 'Local login disabled; use VATSIM login' }); return true; }
      const body = await readBody(req);
      const cid = String(body.cid ?? '').trim();
      const name = String(body.name ?? '').trim();
      if (!/^\d{4,8}$/.test(cid) || !name) { json(res, 400, { error: 'Enter your VATSIM CID and name' }); return true; }
      this.setSession(res, { cid, name, rating: null });
      return true;
    }
    if (url.pathname === '/auth/vatsim') {
      if (!v.clientId) { json(res, 400, { error: 'VATSIM Connect not configured' }); return true; }
      const state = crypto.randomBytes(16).toString('hex');
      this.states.set(state, Date.now());
      const q = new URLSearchParams({ client_id: v.clientId, redirect_uri: v.redirectUri, response_type: 'code', scope: 'full_name vatsim_details', state });
      res.writeHead(302, { Location: `${v.authBase}/oauth/authorize?${q}` });
      res.end();
      return true;
    }
    if (url.pathname === '/auth/vatsim/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      if (!code || !this.states.has(state)) { json(res, 400, { error: 'Invalid OAuth callback' }); return true; }
      this.states.delete(state);
      try {
        const tok = await fetch(`${v.authBase}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: v.clientId, client_secret: v.clientSecret, redirect_uri: v.redirectUri, code }),
        }).then((r) => r.json() as Promise<{ access_token?: string }>);
        if (!tok.access_token) throw new Error('no access token');
        const me = await fetch(`${v.authBase}/api/user`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } }).then(
          (r) => r.json() as Promise<{ data: { cid: string | number; personal?: { name_full?: string }; vatsim?: { rating?: { id?: number } } } }>,
        );
        const d = me.data;
        this.setSession(res, { cid: String(d.cid), name: d.personal?.name_full ?? String(d.cid), rating: d.vatsim?.rating?.id ?? null }, {}, '/');
      } catch (e) {
        json(res, 502, { error: `VATSIM login failed: ${(e as Error).message}` });
      }
      return true;
    }
    return false;
  }
}
