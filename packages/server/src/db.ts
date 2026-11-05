// Audit log of every controller action (the electronic equivalent of struck-through strip
// entries) using Node's built-in SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface EventRow {
  id: number;
  at: number;
  sim_at: number;
  cid: string;
  name: string;
  unit: string;
  callsign: string;
  type: string;
  payload: string;
}

export class Db {
  private db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL, sim_at INTEGER NOT NULL,
        cid TEXT, name TEXT, unit TEXT, callsign TEXT, type TEXT, payload TEXT
      );
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, cid TEXT NOT NULL, name TEXT NOT NULL, rating INTEGER, created INTEGER NOT NULL
      );
    `);
  }
  event(e: Omit<EventRow, 'id'>) {
    this.db
      .prepare('INSERT INTO events (at, sim_at, cid, name, unit, callsign, type, payload) VALUES (?,?,?,?,?,?,?,?)')
      .run(e.at, e.sim_at, e.cid, e.name, e.unit, e.callsign, e.type, e.payload);
  }
  events(sinceMs: number, limit = 2000, callsign?: string): EventRow[] {
    if (callsign) {
      return this.db.prepare('SELECT * FROM events WHERE at >= ? AND callsign = ? ORDER BY id DESC LIMIT ?').all(sinceMs, callsign, limit) as unknown as EventRow[];
    }
    return this.db.prepare('SELECT * FROM events WHERE at >= ? ORDER BY id DESC LIMIT ?').all(sinceMs, limit) as unknown as EventRow[];
  }
  saveSession(token: string, cid: string, name: string, rating: number | null) {
    this.db.prepare('INSERT OR REPLACE INTO sessions (token, cid, name, rating, created) VALUES (?,?,?,?,?)').run(token, cid, name, rating, Date.now());
  }
  session(token: string): { cid: string; name: string; rating: number | null } | undefined {
    const r = this.db.prepare('SELECT cid, name, rating FROM sessions WHERE token = ? AND created > ?').get(token, Date.now() - 7 * 86400_000);
    return r as { cid: string; name: string; rating: number | null } | undefined;
  }
  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}
