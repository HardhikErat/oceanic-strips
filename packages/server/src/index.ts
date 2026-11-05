// Indian Oceanic Strips server: HTTP (static board + auth + API) and WebSockets for
// controllers (/ws) and the EuroScope plugin (/plugin).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Command } from '@oceanic/core';
import { Auth, type SessionUser } from './auth.ts';
import { Clock } from './clock.ts';
import { ROOT, currentAirac, loadConfig } from './config.ts';
import { Db } from './db.ts';
import { Simulator } from './feeds/sim.ts';
import { VatsimFeed } from './feeds/vatsim.ts';
import { loadSectorFiles } from './nav/sectorFiles.ts';
import { PluginBridge } from './plugin.ts';
import { Store, type User } from './store.ts';

const cfg = loadConfig(process.argv.slice(2));
const clock = new Clock();
const db = new Db(path.join(cfg.dataDir, 'strips.db'));

console.log('Reading sector files…');
const nav = loadSectorFiles(cfg.sectorFiles, cfg.units.map((u) => ({ id: u.id, sectorFile: u.sectorFile, ownerId: u.ownerId })), path.join(cfg.dataDir, 'nav-cache.json'));
for (const a of nav.airspaces) {
  if (!a.polygons.length) console.warn(`WARNING: no oceanic sectors found for ${a.id} – check sectorFiles / ownerId in config`);
}
console.log(`AIRAC ${nav.airac}: ${Object.keys(nav.nav.fixes).length} fixes, ${nav.airspaces.map((a) => `${a.id} ${a.polygons.length} sectors`).join(', ')}`);
for (const [k, d] of Object.entries(cfg.sectorFiles)) console.log(`  ${k}: ${path.basename(d)}`);
const airacNow = currentAirac();
if (nav.airac && nav.airac < airacNow) {
  console.warn(`WARNING: sector files are AIRAC ${nav.airac} but AIRAC ${airacNow} is current. Download the new VABF/VOMF/VECF files from AeroNav GNG into "Sector files/".`);
}

const store = new Store(cfg, nav, clock, db);
const auth = new Auth(cfg, db);
const plugins = new PluginBridge(store, cfg.pluginToken);
let feed: VatsimFeed | undefined;
let sim: Simulator | undefined;

if (cfg.dataSource === 'vatsim') {
  feed = new VatsimFeed(store, cfg.vatsimFeedUrl, cfg.vatsimPollSeconds);
  feed.start();
  console.log('Data source: VATSIM data feed');
} else if (cfg.dataSource === 'sim') {
  sim = new Simulator(store, cfg.trainingAutoReports);
  if (cfg.scenario) sim.load(cfg.scenario, cfg.timeScale);
  sim.start();
  console.log(`Data source: simulator (${sim.scenario?.name ?? 'no scenario'})`);
} else {
  console.log('Data source: EuroScope plugin only');
}

setInterval(() => store.tick(), 3000);

// ---------------- HTTP ----------------
const WEB_DIST = path.join(ROOT, 'packages/web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function scenarios() {
  const dir = path.join(ROOT, 'scenarios');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/auth/')) {
      if (await auth.handle(req, res, url)) return;
    }
    if (url.pathname.startsWith('/api/')) {
      const u = auth.user(req);
      if (!u) return json(res, 401, { error: 'login required' });
      if (url.pathname === '/api/events') {
        const since = Number(url.searchParams.get('since') ?? Date.now() - 6 * 3600_000);
        return json(res, 200, db.events(since, 2000, url.searchParams.get('callsign') ?? undefined));
      }
      if (url.pathname === '/api/scenarios') return json(res, 200, scenarios());
      if (url.pathname === '/api/flight') {
        const f = store.flights.get(url.searchParams.get('callsign') ?? '');
        return f ? json(res, 200, f) : json(res, 404, { error: 'not found' });
      }
      return json(res, 404, { error: 'unknown api' });
    }
    // static web board
    let file = path.join(WEB_DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(WEB_DIST)) return json(res, 400, { error: 'bad path' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('Web board not built. Run "npm run build" (or "npm run dev" for development).');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

// ---------------- WebSockets ----------------
interface Client {
  ws: WebSocket;
  user: User;
}
const clients = new Set<Client>();
const wssClients = new WebSocketServer({ noServer: true });
const wssPlugin = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/plugin') {
    wssPlugin.handleUpgrade(req, socket, head, (ws) => plugins.accept(ws));
    return;
  }
  if (url.pathname === '/ws') {
    const u = auth.user(req);
    if (!u) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wssClients.handleUpgrade(req, socket, head, (ws) => onClient(ws, u));
    return;
  }
  socket.destroy();
});

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s);
}

function statusPayload() {
  return {
    type: 'status',
    clock: clock.info(),
    source: cfg.dataSource,
    feed: feed ? { lastOk: feed.lastOk, error: feed.lastError, online: feed.online } : undefined,
    sim: sim?.status(),
    plugins: plugins.status(),
    positions: [...clients].filter((c) => c.user.unit).map((c) => ({ cid: c.user.cid, name: c.user.name, unit: c.user.unit, role: c.user.role })),
  };
}

function helloPayload(user: User) {
  return {
    user,
    authMode: cfg.auth.mode,
    units: cfg.units,
    rules: cfg.rules,
    airac: nav.airac,
    airacCurrent: currentAirac(),
    airspaces: nav.airspaces,
    map: nav.map,
    neighbours: Object.values(nav.positions)
      .filter((p) => /_(CTR|FSS)$/.test(p.callsign))
      .map((p) => ({ callsign: p.callsign, name: p.radioName, frequency: p.frequency })),
    ...store.snapshot(),
    ...statusPayload(),
    type: 'hello',
  };
}

function canCommand(user: User, unit: string) {
  return user.unit === unit && (user.role === 'CONTROLLER' || user.role === 'COORDINATOR');
}

function onClient(ws: WebSocket, su: SessionUser) {
  const client: Client = { ws, user: { cid: su.cid, name: su.name } };
  clients.add(client);
  send(ws, helloPayload(client.user));
  ws.on('message', (data) => {
    let msg: { type: string; id?: number; [k: string]: unknown };
    try { msg = JSON.parse(String(data)); } catch { return; }
    const reply = (ok: boolean, error?: string) => send(ws, { type: 'ack', id: msg.id, ok, error });
    switch (msg.type) {
      case 'join': {
        const unit = String(msg.unit ?? '');
        const role = msg.role as User['role'];
        if (!cfg.units.some((u) => u.id === unit) || !['CONTROLLER', 'COORDINATOR', 'OBSERVER'].includes(role ?? '')) return reply(false, 'invalid unit/role');
        if (role === 'CONTROLLER') {
          const taken = [...clients].find((c) => c !== client && c.user.unit === unit && c.user.role === 'CONTROLLER' && c.user.cid !== client.user.cid);
          if (taken) return reply(false, `${unit} controller position is already taken by ${taken.user.name}`);
        }
        client.user.unit = unit;
        client.user.role = role;
        db.event({ at: Date.now(), sim_at: clock.now(), cid: su.cid, name: su.name, unit, callsign: '', type: 'join', payload: JSON.stringify({ role }) });
        reply(true);
        broadcast(statusPayload());
        return;
      }
      case 'cmd': {
        const cmd = msg.cmd as Command;
        if (!cmd || !('unit' in cmd)) return reply(false, 'bad command');
        if (!canCommand(client.user, cmd.unit)) return reply(false, `You are not controlling ${cmd.unit}`);
        const r = store.apply(cmd, client.user);
        return reply(r.ok, r.error);
      }
      case 'leave':
        client.user.unit = undefined;
        client.user.role = undefined;
        broadcast(statusPayload());
        return;
      case 'whatif': {
        const r = store.whatIf(msg.cmd as Command);
        return send(ws, { type: 'whatif', id: msg.id, ...r });
      }
      case 'ack_conflict':
        if (!client.user.role || client.user.role === 'OBSERVER') return reply(false, 'observers cannot acknowledge');
        store.ackConflict(String(msg.conflictId), client.user);
        return reply(true);
      case 'sim_control': {
        if (!sim) return reply(false, 'not in simulator mode');
        if (typeof msg.scale === 'number' && msg.scale >= 0 && msg.scale <= 16) clock.setScale(msg.scale);
        if (typeof msg.scenario === 'string' && scenarios().includes(msg.scenario)) {
          store.flights.clear();
          store.coord.length = 0;
          store.radio.length = 0;
          sim.load(path.join(ROOT, 'scenarios', msg.scenario));
          for (const c of clients) send(c.ws, helloPayload(c.user));
        }
        broadcast(statusPayload());
        return reply(true);
      }
      case 'ping':
        return send(ws, { type: 'pong', clock: clock.info() });
    }
  });
  ws.on('close', () => {
    clients.delete(client);
    broadcast(statusPayload());
  });
}

store.on('flights', (flights) => broadcast({ type: 'flights', flights }));
store.on('removed', (callsigns) => broadcast({ type: 'removed', callsigns }));
store.on('conflicts', (conflicts) => broadcast({ type: 'conflicts', conflicts }));
store.on('coord', (entry) => broadcast({ type: 'coord', entry }));
store.on('radio', (message) => broadcast({ type: 'radio', message }));
store.on('status', () => broadcast(statusPayload()));
setInterval(() => broadcast({ type: 'live', clock: clock.info(), live: store.liveSnapshot() }), 3000);
setInterval(() => broadcast(statusPayload()), 15000);

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${cfg.port} is already in use – another strip server (e.g. "npm run sim") is probably still running.\n` +
        `Stop it (Ctrl+C in its window), or start this one on another port:  npm start -- --port 8788\n`,
    );
    process.exit(1);
  }
  throw e;
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Indian Oceanic Strips on http://${cfg.host}:${cfg.port}  (auth: ${cfg.auth.mode})`);
  if (cfg.pluginToken === 'change-me') console.warn('WARNING: pluginToken is "change-me" – set PLUGIN_TOKEN or edit config/server.json before exposing the server');
});
