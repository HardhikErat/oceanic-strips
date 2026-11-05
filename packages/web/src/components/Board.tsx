import type { FixStrip, Flight } from '@oceanic/core';
import { highlightFor, type Board as BoardData } from '../derive.ts';
import { client, type BoardConflict, type UnitConfig } from '../state.ts';
import { Strip } from './Strip.tsx';

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

export function Board({ board, unit, conflicts, selected, canEdit, onSelect, onBox, onEstimateIn, onEstimateOut, emptyHint }: Props) {
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
    <div className="board">
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

      <section className="fix-board">
        {board.columns.length === 0 && (
          <div className="empty big">
            {emptyHint ?? `No active strips. Strips print ${unit.printLeadMin} min before the entry estimate and are posted here once the estimate is received.`}
          </div>
        )}
        {board.columns.map((col) => (
          <div key={col.airway} className="route-col">
            <header className="route-head">{col.airway}</header>
            {col.bays.map((bay) => {
              const bayHl = bay.strips.some((s) => highlightFor(conflicts, s.callsign, s.fix)?.direct);
              return (
                <div key={bay.fix} className={`bay ${bayHl ? 'bay-alert' : ''}`}>
                  <div className="designator">
                    <span>{bay.fix}</span>
                    <span className="bay-n">{bay.strips.filter((s) => s.state !== 'PASSED').length}</span>
                  </div>
                  {bay.strips.map((s) => {
                    const f = findFlight(s.callsign);
                    return f ? strip(s, f) : null;
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </section>

    </div>
  );
}

function findFlight(cs: string) {
  return client.state.flights.get(cs);
}
