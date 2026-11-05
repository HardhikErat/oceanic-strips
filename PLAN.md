# Indian Oceanic Strips: VABX / VOMX — Build Plan

Electronic flight progress strip (FPS) system for **Mumbai Radio (VABX)** and **Chennai Radio (VOMX)** on VATSIM. It has two parts: a web strip board and a EuroScope plugin. Everything follows Indian procedures: the India vACC *Oceanic Control Manual* (OCM v1.0), the India–Oman LoA (Para G 1.1), and AAI practice as seen on real Mumbai OCC strips.

Built so Kolkata (VECX) can be added later by config alone.

> **Status (5 Nov 2026):** all phases are implemented, and Kolkata Oceanic (VECX) has been added alongside Mumbai and Chennai. See README.md for running it.
> Separation rules come from the OCM and the LoA, and 26 unit tests cover them.
> The EuroScope plugin builds against the real SDK (32-bit DLL, no warnings), and its network code was tested against the server. It has not yet been loaded in EuroScope itself.
> The open questions in §5 still need India vACC input.

---

## 1. What "realistic" means here

### 1.1 The real strip (from the Mumbai OCC photo)

The photo shows **six strips for one flight (QTR8E, OTHH→VRMM)**. Each strip covers one reporting point on its route (KITAL, BOLUR, DONSA, GOLEM, ESMIT, BIBGO). That is classic Indian procedural **fix posting**. Each strip sits in the bay for its reporting point, sorted by time. The controller finds conflicts by scanning each bay for strips at the same level whose times are too close. The AAIB report on the 2025 PARAR near-miss (ABY405 / BOX622, about 3 min apart) names *"departure from … scanning and updating of the Flight Progress Strips"* as the probable cause. The app must support exactly that workflow. A list view alone is not enough.

Field map of one strip (top row left→right, bottom row underneath):

| Box | Example | Meaning | Controller marks seen in photo |
|---|---|---|---|
| A – Fix / ETO | `KITAL 0053` | Reporting point of **this** strip + estimate (HHMM UTC) | Revised estimate handwritten in blue (`0255` → `45`) |
| B – Level | `350` | Cleared/reported FL | Tick ✓ when level confirmed; new level written, old struck |
| C – Flight ident | `S` / `QTR8E` / `B77W` / `L 2107` / `N0485` | Type of flight (8b) / callsign / type / *see open questions* / TAS | Circled **C** (see open questions) |
| D – Equipment | `SDE1E` | Item 10a equipment (truncated) | — |
| E – Next fix | `BOLUR 0123` | Next point + ETO | Revised ETO written beside (`45`) |
| F – Previous fix | `GOLNI 0045` | Previous point + ETO | — |
| G – Blank write box | | Free-text / coordination | — |
| H – Admin | `2403` `0022` `1` `06` `>` | DOF (DDMM), print/activation time?, strip *n* of 06?, direction chevron | — |
| Bottom row | `OTHH GOLNI P570 KITAL/M083F350 L894 BIBGO/N0491F3 VRMM VOTV PBN/A1B1C1D1L10` | ADEP · Item 15 route as filed · ADES · ALTN · PBN | — |

The app will draw this layout pixel-close: buff paper, printed monospace font, a thin box grid. Controller input appears in a **blue "pen" handwriting font**. An amended value stays visible but **struck through**, as on paper.

### 1.2 Trays / bays (recommended over Planned / Cruise / Exit)

Planned / Cruise / Exit groups strips by *flight*. Real Indian procedural boards group them by *reporting point*, so the recommended layout copies that:

| Bay | Contents | Moves out when |
|---|---|---|
| **Printer / Pending** | Strips just printed (configurable, default 40 min before entry ETO). Set of n strips per flight. | Estimate received from the transferring unit (Muscat, Karachi, Mumbai/Chennai Radar, Male, Colombo, Kuala Lumpur, Jakarta, etc.), or pilot contact |
| **Fix bays** (main board) | One bay per reporting point, with a **designator header strip** (e.g. `KITAL`). Grouped in columns by ATS route/flow (P570, L894, N571, P574, M300 …). Strips sorted by ETO, earliest on top. | Pilot reports over the fix (ATO written) → strip greys out and drops off after N min |
| **Coordination** | Flights within X min of the exit TCP whose estimate has **not** yet been passed to the next unit | Estimate passed (time + unit marked on strip) |
| **Done / Dead** | Flights handed off ("Leaving oceanic airspace, contact …") | Kept for the session (audit trail), as dead strips are kept in real units |

A **Flight view** toggle groups the same strips by flight, which gives your Planned / Cruise / Exit idea for free. Planned = Pending, Cruise = on board, Exit = Coordination + Done. It is useful for new controllers. The fix board stays the default because it is how the real unit works.

### 1.3 Workflow (from OCM §4, §5, §7, §8)

No oceanic clearance request from the pilot (OCM §4). The app models the unit-to-unit "slot" and estimate only:

1. **Print**: strips appear in Pending from the filed FPL and a system estimate.
2. **Estimate in**: the adjacent unit's estimate for the entry point is entered or received. Strips move to the fix bays. The conflict probe runs at once, and the LoA minima apply at the TCP.
3. **First contact**
   - **ADS-B aircraft** (OCM §8.1): copy FL ✓ and Mach ✓ (that is ADS-B identification), then the SELCAL check. Status: *"Remain on SELCAL watch, no position reports required."*
   - **Other aircraft** (OCM §8.2): a **PTLMEE** position report (Position, Time, Level, Mach, Estimate next, next-after). Parsed from one line, e.g. `GIRNA 1715 F350 M080 ELSAR 1755 DUBTA`. ATO goes into Box A of the GIRNA strip. Downstream ETOs are recalculated. SELCAL check ✓. "Report overhead NOPEK" is set as the next required report.
4. **En route**: level/Mach changes (OCM §8.3.1), time restrictions "cross DUBTA at or before/after 1755" (§8.3.2), reroute (§8.3.3), weather deviation (§8.3.5), emergency (§8.3.4). Each is recorded on the strip in pen style.
5. **Estimate out**: pass the estimate to the next unit. The strip is marked with the time and unit.
6. **Exit**: "Position ANGAL, leaving oceanic airspace, contact Muscat Control 128.300". Strips go to Done.

A **phraseology helper** shows the exact OCM wording for each step (callsign "Mumbai Radio" / "Chennai Radio", HF 8.864 alias 128.300, "Namashkar", "Jai Hind").

---

## 2. Separation rules (rule engine is data-driven, every rule cites its source)

### 2.1 Aircraft category (OCM §3)
- **ADS-B**: FPL item 10b contains `B1`/`B2` (plus ADS-C `D1`/`G1`, CPDLC `J*`). Category per aircraft is auto-detected, and the controller can override it on the strip.
- **Other**: everything else.
- **ADS-B minima apply only if BOTH aircraft are ADS-B.** Otherwise the procedural minima apply.

### 2.2 Minima

| Type | ADS-B pair | Other | Source |
|---|---|---|---|
| Vertical | 1000 ft ≤FL410 (all RVSM on VATSIM); 2000 ft FL410–FL450 | same | OCM §6.1 |
| Lateral | 19 NM | 60 NM / 1° | OCM §6.2 (SLOP ignored, §6.2.1) |
| Longitudinal, same track | 4 min at entry point, 15 NM thereafter | 10 min (MNT may reduce) | OCM §6.3.1 |
| Longitudinal, crossing (<90°) | 4 min / 15 NM | 15 min | OCM §6.3.1 |
| Mach Number Technique | — | following slower by 0.02→9, 0.03→8, 0.04→7, 0.05→6, ≥0.06→5 min | OCM §6.3.2 |
| India–Oman boundary | — | 10 min same level/route/direction if preceding Mach ≥ following; 9–5 min per Mach table | LoA Para G 1.1 (a)/(b) |
| Opposite direction, same route | Vertical separation required before the estimated passing time | same | Not stated in the OCM; **confirm with India vACC** |

MNT is applied only if all of these hold: both are turbojets (ES engine type `J`), both have an assigned constant Mach, both have reported over (or been confirmed at) the common point, and the tracks are the same or diverge after it (OCM §6.3.2).

### 2.3 Conflict probe algorithm
For every pair of active flights (n is small, so O(n²) is fine), recomputed on every strip change:

1. **Vertical**: build each flight's level profile over time. Include climbs and descents as a *block* from clearance time until "report reaching". If the vertical minimum holds over the overlap window, the pair is OK.
2. **Lateral**: use route geometry (great-circle segments from nav data). Find the stretches where the two tracks are closer than the lateral minimum for that pair. None means the pair is OK.
3. **Classify** by relative angle in that stretch: same track (shared segment / small angle), crossing (<90°), or opposite.
4. **Longitudinal**: at every common point / intersection / start and end of the stretch, compare the best ETOs. Best ETO order is ATO > pilot estimate > coordinated estimate > system estimate. Get the required minimum from 2.2 (MNT/LoA where they apply). For ADS-B pairs after entry, convert Δt to NM using ground speed (or live ADS-B positions when available).
5. **Result**: `{pair, location, time, actual, required, ruleRef}` with a severity:
   - 🔴 **Loss of separation predicted**: actual < required.
   - 🟠 **Close**: actual < required + buffer (default 2 min / 5 NM, configurable).
   - ⚪ **Unverifiable**: an estimate is missing or stale (e.g. a report is overdue). This is the "nobody updated the strip" trap behind the PARAR incident.

**Highlighting**: every strip of both flights in the affected bay(s) gets a red (or amber) frame and a badge with the other callsign. Hover or click shows "Actual 6 min / required 10 min — OCM 6.3.1". A conflict list panel shows all conflicts. *Acknowledge* mutes the flashing but the highlight stays until the conflict is resolved.

**What-if probe**: before issuing a climb, Mach change, time restriction or reroute, the controller enters it as a draft. The engine says whether it is conflict-free before it is applied.

### 2.4 Estimate engine
- System ETO = last fix time + segment distance ÷ GS. GS comes from TAS (Mach × ISA speed of sound at the FL; tropopause 36,089 ft); no wind on VATSIM, so pilot estimates override.
- **Procedural mode (default for "Other" aircraft):** strips change only from reports and controller entries. Live position is hidden, as it is beyond radar coverage.
- **ADS-B backup mode:** for ADS-B-category aircraft, live position from EuroScope / the VATSIM feed is shown as "backup", as the OCM says ADS-B is used only as a backup. A deviation alarm fires if the live position drifts more than X min from the strip estimate. That flags estimate errors.
- **Overdue report:** a fix ETO that has passed by more than 3 min (configurable) without a report → the strip flashes "OVERDUE".

---

## 3. Architecture

```
 EuroScope (32-bit)                    Backend (Node/TS)                    Browser
┌───────────────────┐   WebSocket   ┌────────────────────────┐   WebSocket   ┌──────────────┐
│ C++ plugin (DLL)  │ ────────────▶ │ Session / strip store  │ ◀───────────▶ │ React strip  │
│ • FPL + route pts │ ◀──────────── │ Conflict + ETO engine  │               │ board (VABX) │
│ • positions       │  amendments   │ Rules (YAML) + navdata │ ◀───────────▶ │ Coordinator  │
│ • tag items       │               │ SQLite audit log       │               │ VOMX board   │
└───────────────────┘               └──────────┬─────────────┘               └──────────────┘
                                               │ fallback / no-ES mode
                                        VATSIM data feed v3
```

- **Engine lives in a shared TS package** (`core`), used by the server (the authoritative copy) and the browser (instant what-if). The plugin only moves data, so the web app also works **without EuroScope** (feed-only mode) for observers, training and development.
- **Multi-controller:** VABX and VOMX boards, plus a **Coordinator** role per FIR (Mumbai OCC uses controller + coordinator), share one backend session. VABX↔VOMX transfers are a real coordination message. Login is VATSIM Connect (OAuth).
- **Local mode:** the backend can run on the controller's PC (`npx`/exe) with no hosting.

### 3.1 EuroScope plugin (C++, MSVC, Win32, ES SDK)
- `OnFlightPlanFlightPlanDataUpdate`, `OnRadarTargetPositionUpdate`, `OnFlightPlanControllerAssignedDataUpdate` → queue → worker-thread WebSocket client (IXWebSocket). **Never block the ES thread**; inbound amendments are applied from `OnTimer`.
- Route points: `GetExtractedRoute()` → names, lat/lon, `GetPointDistanceInMinutes` (as a system-estimate hint only).
- Write-back: cleared FL (`SetClearedAltitude`), Mach (`SetAssignedMach`), strip annotations / scratchpad for ATO and next-report data. These sync to other ES controllers.
- Tag items: `Next fix/ETO`, `Mach`, `ADS-B/PROC`, `Conflict` (red with partner callsign), `Report due`. Tag function: "Open strip in web board".
- Settings file: backend URL, sector (VABX/VOMX), position-data policy.

### 3.2 Backend (Node 20, TypeScript, Fastify + ws, SQLite via Drizzle)
- Strip store: one **Flight** with many **FixStrips**. Every amendment is an event (who, when, old → new), so struck-through history comes for free.
- Navdata importer: fixes, ATS routes and FIR/oceanic sector polygons from the India vACC sector file (.sct/.ese, AeroNav). Route expansion for Item 15 (incl. `KITAL/M083F350` speed/level change points).
- Config: `rules/india-ocm.yaml`, `loa/india-oman.yaml`, `sectors/vabx.yaml`, `sectors/vomx.yaml` (bays, route columns, adjacent units + TCPs + frequencies, print lead time).

### 3.3 Web app (React + Vite + TS, dnd-kit, Zustand)
- Strip component drawn on a CSS grid to the real dimensions; printed font plus a handwriting font for pen entries; blue ink; strike-through history.
- Drag strips between bays; keyboard-first entry (`/r QTR8E GIRNA 1715 F350 M080 ELSAR 1755 DUBTA`).
- Large UTC clock, conflict panel, phraseology helper, pending printer animation.
- Responsive enough for a second monitor or tablet as a "strip bay".

### 3.4 Repository layout
```
/packages/core     ETO engine, separation rules, conflict probe, route parser (+ unit tests)
/packages/server   Fastify/ws backend, persistence, VATSIM feed adapter, auth
/packages/web      React strip board
/plugin            EuroScope plugin (CMake, Win32/MSVC)
/data              rules, LoAs, sector configs, navdata extracts
```

---

## 4. Build phases

| Phase | Deliverable | Done when |
|---|---|---|
| **0 – Data** | Navdata import for VABX/VOMX oceanic fixes/routes; YAML rules + LoA; sector bay layouts | Item 15 of the photo flight expands to GOLNI…BIBGO with lat/lon |
| **1 – Core engine** | ETO calc, ADS-B classification, conflict probe, MNT, LoA | Unit tests cover every OCM §6 row, the LoA table, and a **PARAR replay** (ABY405/BOX622 at 3 min → 🔴) |
| **2 – Web board (feed-only)** | Strip rendering matching the photo; Pending / fix bays / Coordination / Done; PTLMEE entry; highlights | Run a live session from the VATSIM feed with no EuroScope |
| **3 – EuroScope plugin** | Data pump, write-back, tag items | Changing FL on the web shows in ES and vice versa |
| **4 – Multi-unit** | VATSIM Connect, VABX↔VOMX transfer, coordinator role, audit log | Two controllers hand a flight across the Mumbai/Chennai boundary |
| **5 – Realism pass** | Review with India vACC oceanic controllers; training/replay mode | Sign-off on strip layout and procedures |

---

## 5. Open questions — need India vACC / real ATCO confirmation

These come from reading the photo. Each is a config value, not hard-coded:

1. `L 2107` in Box C: SSR code with a prefix? What does `L` mean?
2. The handwritten circled **C** on the BIBGO strip: CPDLC/ADS-C logon, "contact", or coordinated?
3. Box H `2403 / 0022 / 1 / 06 / >`: is it DOF + print time + strip 1 of 6 + direction chevron?
4. Strip holder colours or chevron direction for eastbound/westbound.
5. Strip print lead time before the entry estimate, and how long passed strips stay on the board.
6. Opposite-direction rule and "same track vs crossing" angle threshold. Not in the OCM, so it needs a ruling.
7. Neighbour units, TCPs and transfer frequencies per boundary, and any other LoAs (Karachi, Male, Colombo, Kuala Lumpur, Jakarta …).
8. Real-world AIP also has RNP4 30 NM / RNP10 50 NM and SB-ADS-B 20 NM trials. Should a "real-world AIP" rule profile be added beside the default OCM profile?

---

## 6. References
- India vACC *Oceanic Control Manual* v1.0 (OCM): §3 equipment, §4 clearance, §5 SELCAL, §6 separation, §7 PTLMEE, §8 phraseology
- India–Oman LoA (AAI Mumbai OCC – PACA Muscat ACC, eff. 15 Feb 2016), Para G 1.1
- AAIB report on the PARAR near-miss (ABY405 / BOX622), as reported by the Tribune
- ICAO APAC papers on Indian oceanic separation (10-min crossing proposal, 30 NM RNP4, SB-ADS-B trials)
- EuroScope plugin SDK (`CFlightPlanExtractedRoute`, controller-assigned data)
