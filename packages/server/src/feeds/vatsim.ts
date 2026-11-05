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

export class VatsimFeed {
  private timer?: NodeJS.Timeout;
  online: OnlineController[] = [];
  lastOk = 0;
  lastError = '';
  constructor(private store: Store, private url: string, private pollSec: number) {}

  start() {
    const run = () => this.poll().catch((e) => { this.lastError = String(e); });
    run();
    this.timer = setInterval(run, this.pollSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    const res = await fetch(this.url, { headers: { 'User-Agent': 'IndianOceanicStrips/0.1' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const data = (await res.json()) as { pilots: FeedPilot[]; controllers: { callsign: string; frequency: string; name: string; facility: number }[] };
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
    this.lastOk = Date.now();
    this.lastError = '';
  }
}
