// EuroScope plugin bridge. The plugin connects to ws://host:port/plugin, authenticates with
// the shared token and streams flight plans (with EuroScope-resolved route points) and
// positions. The server pushes back level/Mach amendments and tag data.
import type { WebSocket } from 'ws';
import type { Store } from './store.ts';

interface EsRoutePoint { name: string; lat: number; lon: number }
interface EsFlight {
  callsign: string;
  aircraft: string;
  type?: string;
  rules?: string;
  adep: string;
  ades: string;
  altn?: string;
  route: string;
  rfl: number;
  tas: number;
  remarks: string;
  squawk?: string;
  engine?: string;
  clearedFl?: number;
  mach?: number;
  points?: EsRoutePoint[];
  pos?: { lat: number; lon: number; alt: number; gs: number; hdg?: number };
}

export interface PluginConn {
  ws: WebSocket;
  controller: string;
  unit?: string;
  version?: string;
  connectedAt: number;
  flights: Set<string>;
}

export class PluginBridge {
  conns = new Set<PluginConn>();
  constructor(private store: Store, private token: string) {
    store.on('esAmend', (cs: string, amend: { clearedFl?: number; mach?: number; annotation?: string }) => {
      for (const c of this.conns) if (c.flights.has(cs)) this.send(c, { type: 'amend', callsign: cs, ...amend });
    });
    setInterval(() => this.pushTags(), 3000);
  }

  private send(c: PluginConn, msg: unknown) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  accept(ws: WebSocket) {
    let conn: PluginConn | null = null;
    const timeout = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000);
    ws.on('message', (data) => {
      let msg: { type: string; [k: string]: unknown };
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!conn) {
        if (msg.type !== 'hello' || msg.token !== this.token) {
          ws.send(JSON.stringify({ type: 'error', message: 'bad token' }));
          ws.close(4003, 'unauthorised');
          return;
        }
        clearTimeout(timeout);
        const controller = String(msg.callsign ?? 'UNKNOWN');
        const unit = this.store.cfg.units.find((u) => u.esPositions.includes(controller) || u.id === msg.unit)?.id;
        conn = { ws, controller, unit, version: String(msg.version ?? ''), connectedAt: Date.now(), flights: new Set() };
        this.conns.add(conn);
        this.send(conn, { type: 'welcome', unit, units: this.store.cfg.units.map((u) => ({ id: u.id, radio: u.radioName })) });
        this.store.emit('status');
        return;
      }
      if (msg.type === 'flights' && Array.isArray(msg.flights)) {
        for (const ef of msg.flights as EsFlight[]) {
          conn.flights.add(ef.callsign);
          const now = this.store.clock.now();
          this.store.upsert(
            {
              callsign: ef.callsign,
              aircraft: ef.aircraft,
              aircraftType: ef.type,
              flightRules: ef.rules,
              adep: ef.adep,
              ades: ef.ades,
              altn: ef.altn,
              route: ef.route,
              cruiseLevel: ef.rfl,
              tas: ef.tas,
              remarks: ef.remarks,
              squawk: ef.squawk,
              engineType: ef.engine,
            },
            ef.pos ? { lat: ef.pos.lat, lon: ef.pos.lon, altitudeFt: ef.pos.alt, groundSpeedKt: ef.pos.gs, heading: ef.pos.hdg, time: now } : undefined,
            'ES',
            ef.points,
            { clearedFl: ef.clearedFl, mach: ef.mach },
          );
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (conn) this.conns.delete(conn);
      this.store.emit('status');
    });
  }

  private pushTags() {
    if (!this.conns.size) return;
    const tags = this.store.tagData();
    for (const c of this.conns) {
      const sub: Record<string, unknown> = {};
      for (const cs of c.flights) if (tags[cs]) sub[cs] = tags[cs];
      this.send(c, { type: 'tags', tags: sub });
    }
  }

  status() {
    return [...this.conns].map((c) => ({ controller: c.controller, unit: c.unit, version: c.version, connectedAt: c.connectedAt, flights: c.flights.size }));
  }
}
