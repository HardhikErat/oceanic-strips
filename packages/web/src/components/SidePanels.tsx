import { useEffect, useState } from 'react';
import type { CoordEntry } from '@oceanic/core';
import { fmtTime } from '../derive.ts';
import { client, type BoardConflict, type UnitConfig } from '../state.ts';

export function ConflictList({ conflicts, unit, onSelect, canAck }: { conflicts: BoardConflict[]; unit: UnitConfig; onSelect: (cs: string) => void; canAck: boolean }) {
  const mine = conflicts.filter((c) => c.units.includes(unit.id));
  const others = conflicts.filter((c) => c.units.length && !c.units.includes(unit.id));
  const beyond = conflicts.filter((c) => !c.units.length);
  const row = (c: BoardConflict) => (
    <div key={c.id} className={`conflict-row sev-${c.severity.toLowerCase()} ${c.acknowledged ? 'acked' : ''}`}>
      <div className="cr-head">
        <span className="sev">{c.severity === 'LOS' ? 'LOSS OF SEP' : c.severity === 'WARN' ? 'CLOSE' : 'UNVERIFIED'}</span>
        <span className="kind">{c.kind}</span>
        <span className="t">{fmtTime(c.time)}z</span>
      </div>
      <div className="cr-pair">
        <a onClick={() => onSelect(c.a)}>{c.a}</a> <small>{c.levelA}</small> × <a onClick={() => onSelect(c.b)}>{c.b}</a> <small>{c.levelB}</small>
        {c.location.fix && <span className="at"> @ {c.location.fix}</span>}
      </div>
      <div className="cr-rule">
        {c.kind === 'OPPOSITE'
          ? c.rule.text
          : c.actualNm !== undefined
            ? `${c.actualNm} NM / ${c.requiredNm} NM required`
            : `${c.actualMin} min / ${c.requiredMin} min required`}
      </div>
      <div className="cr-src">
        {c.kind !== 'OPPOSITE' ? `${c.rule.text} · ` : ''}
        {c.rule.source}
        {c.note ? ` · ${c.note}` : ''}
      </div>
      {canAck && !c.acknowledged && <button className="mini" onClick={() => client.ackConflict(c.id)}>Acknowledge</button>}
      {c.acknowledged && <span className="acked-by">ack {c.acknowledged}</span>}
    </div>
  );
  return (
    <div className="panel-list">
      {mine.length === 0 && <div className="empty">No conflicts predicted in {unit.id}</div>}
      {mine.map(row)}
      {others.length > 0 && <div className="sub-head">Other Indian oceanic units</div>}
      {others.map(row)}
      {beyond.length > 0 && (
        <>
          <div className="sub-head">Beyond Indian oceanic airspace – for information</div>
          <div className="hint">These are predicted after the aircraft have left Indian oceanic airspace, so they are the neighbouring unit's traffic. They are not counted or highlighted on your strips.</div>
          <div className="beyond">{beyond.map(row)}</div>
        </>
      )}
    </div>
  );
}

export function CoordLog({ coord, unit }: { coord: CoordEntry[]; unit: UnitConfig }) {
  const list = coord.filter((c) => c.from === unit.id || c.to === unit.id || unit.esPositions.includes(c.to)).slice().reverse();
  return (
    <div className="panel-list">
      {list.length === 0 && <div className="empty">No coordination yet</div>}
      {list.map((c, i) => (
        <div key={i} className={`coord-row k-${c.kind.toLowerCase()}`}>
          <span className="t">{fmtTime(c.at)}</span>
          <span className="dir">{c.from} → {c.to}</span>
          <span className="txt">{c.text}</span>
          {c.by && <span className="by">{c.by}</span>}
        </div>
      ))}
    </div>
  );
}

interface EventRow { id: number; at: number; sim_at: number; name: string; unit: string; callsign: string; type: string; payload: string }

export function AuditLog() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [cs, setCs] = useState('');
  useEffect(() => {
    const load = () =>
      fetch(`/api/events?since=${Date.now() - 12 * 3600_000}${cs ? `&callsign=${encodeURIComponent(cs)}` : ''}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setRows)
        .catch(() => undefined);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [cs]);
  return (
    <div className="panel-list">
      <div className="row">
        <input placeholder="filter callsign" value={cs} onChange={(e) => setCs(e.target.value.toUpperCase())} />
        <a className="mini-link" href={`/api/events?since=${Date.now() - 24 * 3600_000}`} target="_blank" rel="noreferrer">export JSON</a>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="audit-row">
          <span className="t">{fmtTime(r.sim_at)}</span>
          <span className="u">{r.unit}</span>
          <b>{r.callsign}</b>
          <span className="k">{r.type}</span>
          <span className="by">{r.name}</span>
        </div>
      ))}
    </div>
  );
}
