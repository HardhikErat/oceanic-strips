import { useEffect, useState } from 'react';
import type { FixStrip, Flight } from '@oceanic/core';
import { highlightFor, type Board as BoardData } from '../derive.ts';
import { client, type BoardConflict, type UnitConfig } from '../state.ts';
import { Strip } from './Strip.tsx';
import { Splitter, usePanelSize } from './Splitter.tsx';

interface Props {
  board: BoardData;
  unit: UnitConfig;
  conflicts: BoardConflict[];
  selected?: string;
  canEdit: boolean;
  onSelect: (cs: string, fix?: string) => void;
  onBox: (box: 'A' | 'B' | 'G' | 'E', strip: FixStrip) => void;
  onEstimateIn: (f: Flight) => void;
  onEstimateOut: (f: Flight) => void;
  /** shown on an empty board, e.g. while waiting for the VATSIM feed */
  emptyHint?: string;
}


// Each airway gets a fixed colour (same airway = same colour every time). The palette avoids
// red, amber and purple, which mean loss of separation / close / unverified on the strips.
const AIRWAY_COLOURS = ['#4f9cf5', '#2ec4a6', '#e879b9', '#9bd13a', '#22d3ee', '#c9a27e', '#7aa2ff', '#f0abfc', '#5fd38d', '#a3b8c8'];
export function airwayColour(airway: string): string {
  if (airway === 'DCT') return '#8a96a3';
  let h = 0;
  for (const c of airway) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AIRWAY_COLOURS[h % AIRWAY_COLOURS.length];
}

function useCollapsed(unitId: string) {
  const key = `strips-collapsed-${unitId}`;
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
  }, [key, set]);
  const toggle = (aw: string) => setSet((prev) => {
    const n = new Set(prev);
    if (n.has(aw)) n.delete(aw); else n.add(aw);
    return n;
  });
  return [set, toggle] as const;
}

export function Board({ board, unit, conflicts, selected, canEdit, onSelect, onBox, onEstimateIn, onEstimateOut, emptyHint }: Props) {
  const [collapsed, toggleCollapsed] = useCollapsed(unit.id);
  const [leftW, resizeLeft, resetLeft] = usePanelSize('ui-left-w', () => Math.min(560, window.innerWidth * 0.3), 260, () => window.innerWidth * 0.6);
  const [pendH, resizePend, resetPend] = usePanelSize('ui-pend-h', () => window.innerHeight * 0.42, 70, () => window.innerHeight * 0.8);
  const [doneH, resizeDone, resetDone] = usePanelSize('ui-done-h', () => 110, 36, () => window.innerHeight * 0.6);
  const strip = (s: FixStrip, f: Flight, compact = false) => (
    <Strip
      key={s.key}
      strip={s}
      flight={f}
      compact={compact}
      highlight={highlightFor(conflicts, f.callsign, s.fix)}
      selected={selected === f.callsign}
      onSelect={onSelect}
      onBox={canEdit ? onBox : undefined}
      printed={f.units[unit.id]?.printedEtos}
    />
  );

  return (
    <div className="board" style={{ ['--left-w' as string]: `${leftW}px`, ['--pend-h' as string]: `${pendH}px`, ['--done-h' as string]: `${doneH}px` }}>
      <div className="left-stack">
      <section className="bay-col pending-col">
        <header className="bay-col-head">
          <span>PRINTER / PENDING</span>
          <span className="count">{board.pending.length}</span>
        </header>
        <div className="bay-col-body">
          {board.pending.length === 0 && <div className="empty">No strips waiting</div>}
          {board.pending.map(({ flight: f, strips }) => (
            <div key={f.callsign} className="strip-set">
              {(() => {
                const s = strips.find((x) => x.state !== 'PASSED') ?? strips[strips.length - 1];
                return s ? strip(s, f, true) : null;
              })()}
              <div className="set-foot">
                <span className="set-count" title="Strips in this set">
                  {strips.length} strips · {strips.map((s) => s.fix).join(' ')}
                </span>
                {canEdit && (
                  <span className="set-actions">
                    <button onClick={() => onEstimateIn(f)} title="Estimate received from the transferring unit">EST IN</button>
                    <button onClick={() => client.command({ type: 'activate', callsign: f.callsign, unit: unit.id }).catch((e) => alert(e.message))}>POST</button>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <Splitter dir="row" onDrag={resizePend} onReset={resetPend} />
      <section className="bay-col coord-col">
        <header className="bay-col-head">
          <span>COORDINATION</span>
          <span className="count">{board.coordination.length}</span>
        </header>
        <div className="bay-col-body">
          {board.coordination.length === 0 && <div className="empty">No estimates due</div>}
          {board.coordination.map(({ flight: f, strip: s }) => (
            <div key={s.key} className="strip-set coord">
              {strip(s, f, true)}
              <div className="set-foot">
                <span className="set-count">
                  Estimate {s.fix} → {f.units[unit.id]?.nextUnit ?? 'next unit'}
                </span>
                {canEdit && (
                  <span className="set-actions">
                    <button className="primary" onClick={() => onEstimateOut(f)}>EST OUT</button>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <Splitter dir="row" onDrag={(d) => resizeDone(-d)} onReset={resetDone} />
      <section className="bay-col done-col">
        <header className="bay-col-head">
          <span>DONE</span>
          <span className="count">{board.done.length}</span>
        </header>
        <div className="bay-col-body done">
          {board.done.map((f) => (
            <div key={f.callsign} className={`done-row ${selected === f.callsign ? 'selected' : ''}`} onClick={() => onSelect(f.callsign)}>
              <b>{f.callsign}</b>
              <span>{f.units[unit.id]?.exitFix}</span>
              <span>→ {f.units[unit.id]?.handoff?.to}</span>
            </div>
          ))}
        </div>
      </section>
      </div>
      <Splitter dir="col" className="left-split" onDrag={resizeLeft} onReset={resetLeft} />

      <section className="fix-board">
        {board.columns.length === 0 && (
          <div className="empty big">
            {emptyHint ?? `No active strips. Strips print ${unit.printLeadMin} min before the entry estimate and are posted here once the estimate is received.`}
          </div>
        )}
        {board.columns.length > 0 && (
          <nav className="airway-index" aria-label="Airways on the board">
            {board.columns.map((col) => {
              const live = col.bays.reduce((n, b) => n + b.strips.filter((s) => s.state !== 'PASSED').length, 0);
              const alert = col.bays.some((b) => b.strips.some((s) => highlightFor(conflicts, s.callsign, s.fix)?.direct));
              return (
                <button
                  key={col.airway}
                  className={`aw-chip ${collapsed.has(col.airway) ? 'off' : ''}`}
                  style={{ ['--aw' as string]: airwayColour(col.airway) }}
                  title={`Jump to ${col.airway}`}
                  onClick={() => document.getElementById(`aw-${unit.id}-${col.airway}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {col.airway}
                  <b>{live}</b>
                  {alert && <span className="aw-alert">⚠</span>}
                </button>
              );
            })}
          </nav>
        )}
        {board.columns.map((col) => {
          const colour = airwayColour(col.airway);
          const isCollapsed = collapsed.has(col.airway);
          const flights = new Set(col.bays.flatMap((b) => b.strips.map((s) => s.callsign)));
          const live = col.bays.reduce((n, b) => n + b.strips.filter((s) => s.state !== 'PASSED').length, 0);
          const alerts = new Set(col.bays.flatMap((b) => b.strips.filter((s) => highlightFor(conflicts, s.callsign, s.fix)?.direct).map((s) => s.callsign)));
          return (
            <div key={col.airway} id={`aw-${unit.id}-${col.airway}`} className={`route-col ${isCollapsed ? 'collapsed' : ''}`} style={{ ['--aw' as string]: colour }}>
              <header className="route-head" onClick={() => toggleCollapsed(col.airway)} title={isCollapsed ? 'Show this airway' : 'Collapse this airway'}>
                <span className="aw-name">{col.airway}</span>
                <span className="aw-path">{col.bays.map((b) => b.fix).join(' › ')}</span>
                <span className="aw-count">
                  {flights.size} flight{flights.size === 1 ? '' : 's'} · {live} strip{live === 1 ? '' : 's'}
                </span>
                {alerts.size > 0 && <span className="aw-alert" title={`Conflict: ${[...alerts].join(', ')}`}>⚠ {alerts.size}</span>}
                <span className="aw-toggle">{isCollapsed ? '▸' : '▾'}</span>
              </header>
              {!isCollapsed &&
                col.bays.map((bay) => {
                  const bayHl = bay.strips.some((s) => highlightFor(conflicts, s.callsign, s.fix)?.direct);
                  return (
                    <div key={bay.fix} className={`bay ${bayHl ? 'bay-alert' : ''}`}>
                      <div className="designator">
                        <span className={bay.fix.length > 5 ? 'long' : ''}>{bay.fix}</span>
                        <span className="bay-n">{bay.strips.filter((s) => s.state !== 'PASSED').length}</span>
                      </div>
                      {bay.strips.map((s) => {
                        const f = findFlight(s.callsign);
                        if (!f) return null;
                        return (
                          <div key={s.key} className="strip-wrap">
                            {strip(s, f)}
                            {canEdit && (
                              <button
                                className="unpost"
                                title={`Back to Pending – take all ${f.callsign} strips off the board`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  client.command({ type: 'unpost', callsign: f.callsign, unit: unit.id }).catch((err) => alert(err.message));
                                }}
                              >
                                ↩
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </section>

    </div>
  );
}

function findFlight(cs: string) {
  return client.state.flights.get(cs);
}
