// Client state: one WebSocket to the server, clock sync, command acks.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Command, Conflict, CoordEntry, Flight, LatLon, RadioMessage, SeparationRules, UnitAirspace } from '@oceanic/core';

export interface UnitConfig {
  id: string;
  name: string;
  radioName: string;
  esPositions: string[];
  frequency: string;
  hf: string;
  printLeadMin: number;
  coordLeadMin: number;
  passedRetentionMin: number;
}

export interface User {
  cid: string;
  name: string;
  unit?: string;
  role?: 'CONTROLLER' | 'COORDINATOR' | 'OBSERVER';
}

export interface StatusMsg {
  clock: { simNow: number; realNow: number; scale: number };
  source: string;
  feed?: { lastOk: number; error: string; online: { callsign: string; frequency: string; name: string }[] };
  sim?: { scenario?: string; description?: string; aircraft: number; scale: number };
  plugins: { controller: string; unit?: string; version?: string; connectedAt: number; flights: number }[];
  positions: { cid: string; name: string; unit: string; role: string }[];
}

export type BoardConflict = Conflict & { acknowledged?: string };

export interface AppState {
  phase: 'loading' | 'login' | 'connecting' | 'ready' | 'disconnected';
  authMode: 'local' | 'vatsim';
  user?: User;
  units: UnitConfig[];
  rules?: SeparationRules;
  airac: string;
  airacCurrent?: string;
  setupProblems?: string[];
  airspaces: UnitAirspace[];
  map: { airways: { name: string; points: [number, number][] }[]; fixes: { name: string; lat: number; lon: number }[] };
  neighbours: { callsign: string; name: string; frequency: string }[];
  flights: Map<string, Flight>;
  conflicts: BoardConflict[];
  coord: CoordEntry[];
  radio: RadioMessage[];
  status?: StatusMsg;
  error?: string;
}

type Listener = () => void;

class Client {
  state: AppState = {
    phase: 'loading',
    authMode: 'local',
    units: [],
    airac: '',
    airspaces: [],
    map: { airways: [], fixes: [] },
    neighbours: [],
    flights: new Map(),
    conflicts: [],
    coord: [],
    radio: [],
  };
  version = 0;
  private listeners = new Set<Listener>();
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<number, (m: { ok: boolean; error?: string; [k: string]: unknown }) => void>();
  private clockSync = { sim: Date.now(), real: Date.now(), scale: 1 };
  private retry = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.version++;
    this.listeners.forEach((l) => l());
  }

  now() {
    return this.clockSync.sim + (Date.now() - this.clockSync.real) * this.clockSync.scale;
  }

  private syncClock(c?: { simNow: number; realNow: number; scale: number }) {
    if (!c) return;
    // assume negligible latency on a local/vACC server
    this.clockSync = { sim: c.simNow, real: Date.now(), scale: c.scale };
  }

  async init() {
    try {
      const cfg = await fetch('/auth/config').then((r) => r.json());
      const me = await fetch('/auth/me');
      if (me.ok) {
        const { user } = await me.json();
        this.set({ authMode: cfg.mode, user, phase: 'connecting' });
        this.connect();
      } else this.set({ authMode: cfg.mode, phase: 'login' });
    } catch {
      this.set({ phase: 'disconnected', error: 'Server not reachable' });
      setTimeout(() => this.init(), 3000);
    }
  }

  async loginLocal(cid: string, name: string) {
    const r = await fetch('/auth/local', { method: 'POST', body: JSON.stringify({ cid, name }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? 'Login failed');
    this.set({ user: j.user, phase: 'connecting' });
    this.connect();
  }

  async logout() {
    await fetch('/auth/logout', { method: 'POST' });
    this.ws?.close();
    this.set({ user: undefined, phase: 'login' });
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onopen = () => { this.retry = 0; };
    ws.onclose = () => {
      if (this.state.phase === 'login') return;
      this.set({ phase: 'disconnected' });
      setTimeout(() => this.connect(), Math.min(10000, 1000 * 2 ** this.retry++));
    };
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'hello': {
        this.syncClock(m.clock);
        let prevUnit = this.state.user?.unit;
        let prevRole = this.state.user?.role;
        if (!prevUnit) {
          try {
            const saved = JSON.parse(localStorage.getItem('strips-position') ?? 'null');
            if (saved?.cid === m.user.cid) { prevUnit = saved.unit; prevRole = saved.role; }
          } catch { /* storage unavailable */ }
        }
        this.set({
          phase: 'ready',
          user: { ...m.user, unit: prevUnit, role: prevRole },
          authMode: m.authMode,
          units: m.units,
          rules: m.rules,
          airac: m.airac,
          airacCurrent: m.airacCurrent,
          setupProblems: m.setupProblems,
          airspaces: m.airspaces,
          map: m.map,
          neighbours: m.neighbours,
          flights: new Map((m.flights as Flight[]).map((f) => [f.callsign, f])),
          conflicts: m.conflicts,
          coord: m.coord,
          radio: m.radio,
          status: m,
          error: undefined,
        });
        // re-join after reconnect / reload
        if (prevUnit && prevRole) {
          this.set({ user: { ...m.user } });
          this.join(prevUnit, prevRole).catch(() => undefined);
        }
        break;
      }
      case 'flights': {
        const map = new Map(this.state.flights);
        for (const f of m.flights as Flight[]) map.set(f.callsign, f);
        this.set({ flights: map });
        break;
      }
      case 'removed': {
        const map = new Map(this.state.flights);
        for (const cs of m.callsigns as string[]) map.delete(cs);
        this.set({ flights: map });
        break;
      }
      case 'live': {
        this.syncClock(m.clock);
        const map = new Map(this.state.flights);
        let changed = false;
        for (const l of m.live as { callsign: string; live: Flight['live']; atos: Flight['atos'] }[]) {
          const f = map.get(l.callsign);
          if (f) { map.set(l.callsign, { ...f, live: l.live, atos: l.atos }); changed = true; }
        }
        if (changed) this.set({ flights: map });
        break;
      }
      case 'conflicts':
        this.set({ conflicts: m.conflicts });
        break;
      case 'coord':
        this.set({ coord: [...this.state.coord.slice(-300), m.entry] });
        break;
      case 'radio': {
        const list = this.state.radio.filter((r) => r.id !== m.message.id);
        this.set({ radio: [...list.slice(-200), m.message] });
        break;
      }
      case 'status':
        this.syncClock(m.clock);
        this.set({ status: m });
        break;
      case 'ack':
      case 'whatif': {
        const cb = this.pending.get(m.id);
        if (cb) { this.pending.delete(m.id); cb(m); }
        break;
      }
    }
  }

  private request<T extends { ok: boolean; error?: string }>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Not connected'));
      const id = ++this.seq;
      this.pending.set(id, (r) => resolve(r as T));
      this.ws.send(JSON.stringify({ ...msg, id }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Server did not answer')); }
      }, 8000);
    });
  }

  async join(unit: string, role: NonNullable<User['role']>) {
    const r = await this.request({ type: 'join', unit, role });
    if (!r.ok) throw new Error(r.error);
    this.set({ user: { ...this.state.user!, unit, role } });
    try { localStorage.setItem('strips-position', JSON.stringify({ cid: this.state.user!.cid, unit, role })); } catch { /* ignore */ }
  }

  leave() {
    this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: 'leave' }));
    this.set({ user: { ...this.state.user!, unit: undefined, role: undefined } });
    try { localStorage.removeItem('strips-position'); } catch { /* ignore */ }
  }

  async command(cmd: Command) {
    const r = await this.request({ type: 'cmd', cmd });
    if (!r.ok) throw new Error(r.error);
  }

  whatIf(cmd: Command) {
    return this.request<{ ok: boolean; error?: string; conflicts?: Conflict[]; route?: string[] }>({ type: 'whatif', cmd });
  }

  ackConflict(id: string) {
    return this.request({ type: 'ack_conflict', conflictId: id });
  }

  simControl(p: { scale?: number; scenario?: string }) {
    return this.request({ type: 'sim_control', ...p });
  }
}

export const client = new Client();

export function useApp(): AppState {
  useSyncExternalStore(client.subscribe, client.getVersion);
  return client.state;
}

/** Re-render on an interval and return the (simulation-aware) current time. */
export function useNow(intervalMs = 1000): number {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return client.now();
}

export function unitById(units: UnitConfig[], id?: string) {
  return units.find((u) => u.id === id);
}

export type { LatLon };
