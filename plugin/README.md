# EuroScope plugin – Indian Oceanic Strips

Connects EuroScope (with the VABF, VOMF or VECF sector file loaded) to the strip server.

**What it sends** (every 5 s): IFR flight plans whose route touches the Indian Ocean region, including:
- the route points as EuroScope resolved them from your sector file;
- the correlated position;
- the cleared level and assigned Mach.

**What it receives:**
- Level and Mach changes made on the web board, applied with `SetClearedAltitude` / `SetAssignedMach`. EuroScope only accepts these for flights you can amend, for example ones you are tracking.
- The last position report, written to strip annotation 8.
- Tag data for the tag items listed below.

## Tag items (TAG editor → plug-in items)
| Item | Shows |
|---|---|
| Oceanic: next fix / estimate | `BOLUR 1306` |
| Oceanic: ADS-B / procedural | `ADS` / `PRC` |
| Oceanic: conflict partner | `!QTR678` red (loss of separation), amber (close), purple (unverified) |
| Oceanic: report overdue | `DUE` |
| Oceanic: Mach | `M83` |

Tag function **Oceanic: open strip board** opens the web board with that flight selected.

## Commands
```
.oceanic url ws://127.0.0.1:8787/plugin
.oceanic token <same as pluginToken / PLUGIN_TOKEN on the server>
.oceanic board http://127.0.0.1:8787/
.oceanic connect
.oceanic status
```

## Building (32-bit, MSVC)
EuroScope is a 32-bit application, so the DLL must be built for Win32. The SDK (`EuroScopePlugIn.h` and `EuroScopePlugInDll.lib`) comes with EuroScope. On this PC it is in `%APPDATA%\EuroScope\PlugIn`.

```
cmake -S plugin -B plugin/build -G "Visual Studio 17 2022" -A Win32 -DES_SDK_DIR="%APPDATA%/EuroScope/PlugIn"
cmake --build plugin/build --config Release
```

The output is `plugin/build/Release/OceanicStrips.dll`:
- 32-bit;
- exports `EuroScopePlugInInit` / `EuroScopePlugInExit`;
- static C runtime, so only `EuroScopePlugInDll.dll` (from EuroScope) and Windows' WinHTTP are needed.

## Installing
1. Start the strip server (`npm start`, or `npm run sim` for training).
2. In EuroScope: *Other Set → Plug-ins → Load*, then pick `OceanicStrips.dll`.
3. If you changed the server's `pluginToken`, set it in EuroScope:
   ```
   .oceanic token <token>
   ```
4. Add the tag items below in the TAG editor.

The plugin maps your login callsign to a unit: `VABF_OC_CTR` → VABX, `VOMF_OC_CTR` → VOMX, `VECF_OC_CTR` → VECX.

## Network test without EuroScope
`test/ws_harness.cpp` builds the plugin's own `WsClient` and JSON code into a console program. It connects like the DLL does, sends one flight, and prints the welcome, tag and `amend` messages.

```
plugin\test\build_harness.bat
plugin\build\harness\ws_harness.exe ws://127.0.0.1:8787/plugin change-me 15
```

## Level/Mach sync rule
The board is authoritative for oceanic clearances. EuroScope's cleared level or Mach is copied to the strips only when it **changes in EuroScope**. If EuroScope keeps reporting an old value, the board's value is not overwritten. That happens when an amendment from the board has not been applied yet, or was refused because you are not tracking the aircraft.

`plugin/sdk-stub/` is a **compile-check stub only** (`check.bat`). It is not the SDK.
