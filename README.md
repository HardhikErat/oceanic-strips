# Indian Oceanic Strips (VABX / VOMX / VECX)

Electronic flight progress strips for **Mumbai Radio (VABX)**, **Chennai Radio (VOMX)** and **Kolkata Radio (VECX)** on VATSIM. It has three parts:

- a **web strip board**;
- a **strip server** that builds strips and predicts separation losses using the Indian rules;
- a **EuroScope plugin**.

The design follows the India vACC *Oceanic Control Manual* v1.0, the India–Oman LoA (Para G 1.1) and the AAI Mumbai OCC strip layout. See [PLAN.md](PLAN.md) for the design rationale.

> For use on the VATSIM network only. Not for real-world aviation.

## Quick start

Requirements: Node.js 22.5 or later (it uses the built-in `node:sqlite`). For the plugin only, Visual Studio with the C++ toolset.

```bash
npm install
npm run build
```

**Training:** a simulator flies the scenario traffic and makes the HF calls.

```bash
npm run sim
```

**Live:** strips come from the VATSIM data feed, and from the EuroScope plugin when it is connected.
For each flight, EuroScope's data (flight plan, resolved route, position, cleared level and Mach) takes priority while a plugin is sending it. If EuroScope has no radar target for a flight, the feed's position is still used. Thirty seconds after EuroScope stops sending a flight (plugin disconnected, or the aircraft is out of its range), the feed takes the flight over again.

```bash
npm start
```

Open http://127.0.0.1:8787, log in, and pick **Mumbai Radio**, **Chennai Radio** or **Kolkata Radio** as Controller, Coordinator or Observer.

For development, `npm run dev` runs the server and Vite hot reload together (open http://localhost:5173).

### Sector files
The server reads **your own installed** VABF, VOMF and VECF sector files at start-up. Paths are set in `config/server.json` → `sectorFiles`. From those files it takes:
- oceanic sectors (ESE first owner `BOC` Mumbai / `COC` Chennai / `KOX` Kolkata);
- fixes, airways and airports;
- neighbour positions and frequencies.

The parsed cache is written to `data/local/`. That folder is git-ignored.

**AIRAC updates.** `config/server.json` uses `Sector files/VABF-Install_*`, `VOMF-Install_*` and `VECF-Install_*`, so the server always uses the **newest** install folder.
1. Download the new VABF, VOMF and VECF packages from AeroNav GNG.
2. Extract them into `Sector files/` next to the old ones.
3. Restart the server.

The cache rebuilds automatically. The server log and the board's top bar warn in red when the installed AIRAC is older than the current one.

> The AeroNav notice forbids redistributing these files or anything derived from them. Do not commit or publish `Sector files/` or `data/local/`.

## The board
| Area | What it does |
|---|---|
| **Printer / Pending** | Strip sets print 40 min before the entry estimate (`printLeadMin`). **EST IN** records the estimate from the transferring unit and posts the strips. **POST** posts them without an estimate. |
| **Fix bays** | One bay per reporting point, each with a black designator header. Bays are grouped in columns by ATS route and strips are sorted by estimate. This is how conflicts are found by scanning strips. |
| **Coordination** | The exit strip moves here when the exit estimate is within 30 min (`coordLeadMin`) and has not been passed. **EST OUT** passes it. |
| **Done** | Flights that have been handed off. Click one to recall it. |
| **Side panel** | Conflicts · HF inbox (simulated pilot calls) · coordination log · map · audit log · help. |
| **Command line** | Press `/` to focus it, e.g. `QTR8E R KITAL 0053 F350 M083 BOLUR 0123 DONSA`. Type `HELP` for the list. |

**The strip** copies the Mumbai OCC paper strip.

Top row, left to right:
1. Fix and estimate.
2. Level.
3. Type of flight, callsign, type, SSR code and TAS.
4. Equipment.
5. Next fix and its estimate.
6. Previous fix and its estimate.
7. Write boxes.
8. DOF, print time, strip n of total, and the direction chevron.

The bottom row shows ADEP, the route as filed, ADES, ALTN and PBN.

Controller entries are drawn in a blue pen font, and the printed value they replace is struck through. Like the handwritten "45" in the photo, a time keeps only its minutes when the hour has not changed.

Other marks:
- Ⓒ on the exit strip means the estimate has been passed.
- R means the next report is required at that fix.
- ✓ in the level box means the level is confirmed.

Double-click Box A to enter a report and the next-fix box to revise its estimate. Click a strip to open the flight panel.

**The flight panel** follows OCM §8:
- **ADS-B aircraft:** FL and Mach copied (ADS-B identification), SELCAL check, "remain on SELCAL watch, no position reports required".
- **Other aircraft:** PTLMEE position reports, SELCAL check, next report point.
- **Clearances:** level and Mach, time restriction, reroute and weather deviation. Each can be checked with **Probe** (what-if) before you issue it.
- **Also:** emergency, estimate out and hand-off, the estimates table, strip marks, and the history.

## Conflict detection (OCM §6, LoA)
After every strip change and every 3 s, the server checks every pair of printed flights.

Each check uses the strip estimates, in this order of precedence:
1. ATO;
2. pilot, coordinated or controller estimate;
3. calculated from Mach at ISA with no wind.

| Check | ADS-B pair | Other |
|---|---|---|
| Vertical | 1000 ft up to FL410, 2000 ft above | same |
| Lateral | 19 NM | 60 NM (weather deviation widens it) |
| Same track (< 45°) | 4 min at entry, then 15 NM (closest approach) | 10 min. Mach Number Technique 9–5 min when both are turbojets with assigned Mach and the preceding aircraft is faster. India–Oman LoA at Muscat TCPs |
| Crossing (45–135°) | 4 min / 15 NM | 15 min |
| Opposite (> 135°) | vertical separation required 10 min either side of the passing time *(not in the OCM, needs confirmation)* | same |

A climb or descent is protected as a block until the pilot reports reaching.

Strips involved in a conflict are framed:
- **red:** loss of separation predicted;
- **amber:** within 2 min / 5 NM of the minimum;
- **purple dashed:** a report is overdue, so separation cannot be verified.

Each highlighted strip shows a badge with the other callsign. The conflict panel shows the actual and required separation and the rule that applies.

Rules live in `packages/core/src/rules.ts`. They can be overridden in `config/rules.json`, which holds the LoA TCPs.

## Positions, coordination, auth
- **Roles:** each unit has one **Controller** plus any number of **Coordinators** and **Observers**. Only a unit's controller or coordinator can change its strips.
- **Transfers between Indian units** (Mumbai ↔ Chennai ↔ Kolkata): when one unit passes an estimate or hands off to another, the receiving unit's strips are posted automatically. Both boards see it in the coordination log. When a route goes straight from one Indian oceanic unit into the next, that unit is shown as the next unit even if the route clips a corner of a foreign FIR in between.
- **Login:** local login (CID + name, no password) is the default and is meant for a server on your own PC.
- **VATSIM Connect:** set `VATSIM_CLIENT_ID`, `VATSIM_CLIENT_SECRET` and `VATSIM_REDIRECT_URI` to enable it.
- **Audit log:** every action is stored in `data/local/strips.db` and can be exported from the Log tab.
- **Plugin token:** set `PLUGIN_TOKEN`, or `pluginToken` in the config, before exposing the server beyond localhost.

## Training scenarios (`scenarios/`)
- `training-mixed.json` covers:
  - the photo flight QTR8E with a follower 7 min behind;
  - a crossing at DONSA;
  - an ADS-B pair on M300;
  - a VABX→VOMX transfer on N563;
  - on P574, a procedural flight that misses a report and an opposite-direction aircraft at the same level.
- `kolkata-bay-of-bengal.json` covers:
  - IGO53 Kolkata→Kuala Lumpur on L759, Kolkata→Chennai;
  - SIA406 Singapore→Delhi on W111, Chennai→Kolkata at VATLA;
  - SIA406 crossing THA323 (N895) at BUBKO 11 min apart at the same level;
  - AIC775 Port Blair→Kolkata on P628.
- `photo-qtr8e.json` recreates the photo strip set: 24 Mar, KITAL 0053, six strips from KITAL to BIBGO.
- `boundary-3min.json` has two aircraft 3 min apart at the KITAL boundary point (the LoA requires 10).
- `mach-technique.json` has Mach Number Technique pairs on L894.

Use the topbar selectors to switch scenario and run at ×1–×8 or paused.

## Project layout
```
packages/core     separation rules, conflict probe, ETO engine, route/FPL parsing, PTLMEE parser (+ tests)
packages/server   sector-file reader, VATSIM feed, simulator, plugin bridge, auth, audit log
packages/web      React strip board
plugin            EuroScope plugin (C++ / WinHTTP), see plugin/README.md
config            server, unit, rule/LoA and neighbour configuration
scenarios         training scenarios
```

`npm test` runs the core tests (OCM/LoA separation cases, MNT, PTLMEE, route parsing). `npm run typecheck` checks all packages.

## Needs confirmation by India vACC
See PLAN.md §5. These are settings, not hard-coded:
- the meaning of `L 2107` and of the circled C on the strip;
- the Box H fields;
- print and coordination lead times;
- the opposite-direction rule;
- the Muscat TCP list;
- strip holder colours.
