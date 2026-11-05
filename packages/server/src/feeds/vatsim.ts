// VATSIM public data feed (v3). Used when no EuroScope plugin is connected, and for
// observers / training on the web board alone.
import type { Store } from '../store.ts';

interface FeedPilot {
  callsign: string;
  latitude: number;
  longitude: number;
  altitude: number;
  groundspeed: number;
  heading: number;
  transponder: string;
  last_updated: string;
  flight_plan?: {
    flight_rules: string;
    aircraft: string;
    aircraft_short: string;
    departure: string;
    arrival: string;
    alternate: string;
    cruise_tas: string;
    altitude: string;
    remarks: string;
    route: string;
    assigned_transponder: string;
  };
}

export interface OnlineController {
  callsign: string;
  frequency: string;
  name: string;
}

const STATUS_URL = 'https://status.vatsim.net/status.json';
const USER_AGENT = 'IndianOceanicStrips/0.1';

export class VatsimFeed {
  private timer?: NodeJS.Timeout;
  online: OnlineController[] = [];
  lastOk = 0;
  lastError = '';
  /** a download is in progress (never start a second one) */
  busy = false;
  startedAt = Date.now();
  private retry?: NodeJS.Timeout;
  private urls: string[];
  constructor(private store: Store, private url: string, private pollSec: number) {
    this.urls = [url];
  }

  start() {
    this.startedAt = Date.now();
    this.refreshUrls().finally(() => this.run());
    this.timer = setInterval(() => this.run(), this.pollSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
  }

  /** VATSIM publishes the current data-feed addresses in status.json */
  private async refreshUrls() {
    try {
      const res = await fetch(STATUS_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { data?: { v3?: string[] } };
      const v3 = (j.data?.v3 ?? []).filter((u) => typeof u === 'string' && u.startsWith('https://'));
      if (v3.length) this.urls = [...new Set([this.url, ...v3])];
    } catch {
      /* keep the configured address */
    }
  }

  private run() {
    if (this.busy) return;
    this.busy = true;
    this.poll()
      .catch(async (e) => {
        this.lastError = e instanceof Error && e.name === 'TimeoutError' ? 'VATSIM data feed did not answer within 20 s' : String(e instanceof Error ? e.message : e);
        console.warn(`VATSIM feed: ${this.lastError} – retrying in 5 s`);
        this.store.emit('status');
        await this.refreshUrls();
        // retry soon after a failure instead of waiting for the next regular poll
        if (this.retry) clearTimeout(this.retry);
        this.retry = setTimeout(() => this.run(), 5_000);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private async fetchFeed() {
    let last: unknown;
    for (const url of this.urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`VATSIM data feed HTTP ${res.status}`);
        return (await res.json()) as { pilots: FeedPilot[]; controllers: { callsign: string; frequency: string; name: string; facility: number }[] };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  private async poll() {
    const data = await this.fetchFeed();
    const now = this.store.clock.now();
    for (const p of data.pilots) {
      const fp = p.flight_plan;
      if (!fp || fp.flight_rules !== 'I' || !fp.route) continue;
      const alt = fp.altitude.toUpperCase().replace(/^FL/, '');
      const lvl = Number(alt) || 0;
      this.store.upsert(
        {
          callsign: p.callsign,
          aircraft: fp.aircraft || fp.aircraft_short,
          aircraftType: fp.aircraft_short,
          flightRules: fp.flight_rules,
          adep: fp.departure,
          ades: fp.arrival,
          altn: fp.alternate,
          route: fp.route,
          cruiseLevel: lvl < 1000 ? lvl : lvl,
          tas: Number(fp.cruise_tas) || 0,
          remarks: fp.remarks,
          squawk: fp.assigned_transponder !== '0000' ? fp.assigned_transponder : p.transponder,
        },
        { lat: p.latitude, lon: p.longitude, altitudeFt: p.altitude, groundSpeedKt: p.groundspeed, heading: p.heading, time: now },
        'VATSIM',
      );
    }
    this.online = data.controllers
      .filter((c) => /_(CTR|FSS)$/.test(c.callsign))
      .map((c) => ({ callsign: c.callsign, frequency: c.frequency, name: c.name }));
    const recovered = !this.lastOk || !!this.lastError;
    if (recovered) console.log(`VATSIM feed: OK (${data.pilots.length} pilots)`);
    this.lastOk = Date.now();
    this.lastError = '';
    if (recovered) this.store.emit('status');
  }
}
