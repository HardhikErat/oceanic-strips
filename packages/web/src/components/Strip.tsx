// One fix strip, laid out like the AAI Mumbai OCC printed strip (PLAN.md §1.1).
// Printed fields use the printer font; controller entries are drawn in blue "pen".
import type { FixStrip, Flight } from '@oceanic/core';
import { fmtTime, machText, penTime, type StripHighlight } from '../derive.ts';

interface Props {
  strip: FixStrip;
  flight: Flight;
  highlight?: StripHighlight;
  selected?: boolean;
  onSelect?: (cs: string, fix: string) => void;
  onBox?: (box: 'A' | 'B' | 'G' | 'E', strip: FixStrip) => void;
  printed?: Record<string, number>;
  compact?: boolean;
}

function TimeCell({ printed, current, ato }: { printed?: number; current?: number; ato?: number }) {
  // printed estimate (as on paper); revisions in pen with the printed value struck through
  const base = printed ?? current;
  const revised = current !== undefined && base !== undefined && Math.abs(current - base) >= 60_000;
  return (
    <span className="tcell">
      <span className={`printed ${revised || ato !== undefined ? 'struck' : ''}`}>{fmtTime(base)}</span>
      {ato !== undefined ? (
        <span className="pen ato" title="Actual time over">{penTime(ato, base)}✓</span>
      ) : revised ? (
        <span className="pen" title="Revised estimate">{penTime(current!, base)}</span>
      ) : null}
    </span>
  );
}

export function Strip({ strip: s, flight: f, highlight, selected, onSelect, onBox, printed, compact }: Props) {
  const us = f.units[s.unit];
  const L = f.level;
  const printedLevel = f.fpl.rfl;
  const levelChanged = L.cleared !== printedLevel;
  const marks = s.marks.symbols ?? [];
  const coordinated = s.isExit && !!us?.estimateOut;
  const hl = highlight ? `hl-${highlight.severity.toLowerCase()} ${highlight.direct ? 'hl-direct' : 'hl-indirect'}` : '';
  const partner = highlight?.conflicts.map((c) => (c.a === f.callsign ? c.b : c.a));
  const nextReport = us?.nextReportFix === s.fix && s.state !== 'PASSED';
  const restriction = f.restrictions.find((r) => r.fix === s.fix);
  const route = f.fpl.route;
  // ADS-B shows the aircraft at a different level from the strip (common on VATSIM)
  const liveFl = f.live && f.category === 'ADSB' && f.live.altitudeFt > 10000 ? Math.round(f.live.altitudeFt / 100) : undefined;
  const inChange = L.previous !== undefined && !L.confirmed;
  const levelMismatch = liveFl !== undefined && !inChange && !L.block && Math.abs(liveFl - L.cleared) >= 4 ? Math.round(liveFl / 10) * 10 : undefined;

  return (
    <div
      className={`strip dir-${s.direction === '>' ? 'e' : 'w'} ${s.state === 'PASSED' ? 'passed' : ''} ${hl} ${selected ? 'selected' : ''} ${f.emergency ? 'emerg' : ''} ${compact ? 'compact' : ''}`}
      onClick={() => onSelect?.(f.callsign, s.fix)}
      data-callsign={f.callsign}
      data-fix={s.fix}
    >
      <div className="holder" />
      <div className="paper">
        <div className="row1">
          <div className="box a" onDoubleClick={(e) => { e.stopPropagation(); onBox?.('A', s); }} title="Double-click: report / revise estimate">
            <span className="fix">{s.fix}</span>
            <TimeCell printed={s.printedEto} current={s.eto} ato={s.ato} />
            {s.overdue && <span className="overdue">OVERDUE</span>}
            {nextReport && !s.overdue && <span className="pen nr" title="Next report required">R</span>}
          </div>
          <div className="box b" onDoubleClick={(e) => { e.stopPropagation(); onBox?.('B', s); }} title="Double-click: level">
            <span className={`printed lvl ${levelChanged ? 'struck' : ''}`}>{printedLevel}</span>
            {levelChanged && (
              <span className="pen lvl">
                {L.block ? `${L.block[0]}B${L.block[1]}` : L.cleared}
                {!L.confirmed && L.previous !== undefined && <span className="arrow">{L.cleared > L.previous ? '↑' : '↓'}</span>}
              </span>
            )}
            {L.confirmed && <span className="pen tick">✓</span>}
            {levelMismatch !== undefined && (
              <span className="lvl-mismatch" title={`ADS-B shows FL${levelMismatch}, strip has F${L.cleared}`}>ADS {levelMismatch}</span>
            )}
          </div>
          <div className="box c">
            <span className="tof">{f.fpl.typeOfFlight}</span>
            <span className="c-top">
              <span className={`cat cat-${f.category.toLowerCase()}`} title={f.category === 'ADSB' ? 'ADS-B aircraft (OCM §3)' : 'Other aircraft – procedural'}>
                {f.category === 'ADSB' ? 'ADS-B' : 'PROC'}
              </span>
              {us?.contact && <span className="pen contact" title="Contact established">✓</span>}
            </span>
            <span className="type">{f.fpl.aircraftType}</span>
            <span className="cs">{f.callsign}</span>
            <span className="ssr">L {f.fpl.squawk || '----'}</span>
            <span className="c-bot">{f.mach !== undefined && <span className="pen mach">{machText(f.mach)}</span>}</span>
            <span className="tas">N{String(f.fpl.tas).padStart(4, '0')}</span>
          </div>
          <div className="box d">
            <span className="eq" title={`Item 10a ${f.fpl.equipment} / 10b ${f.fpl.surveillance}`}>{f.fpl.equipment.slice(0, 5)}</span>
          </div>
          <div className="box e" onDoubleClick={(e) => { e.stopPropagation(); onBox?.('E', s); }}>
            {s.next && (
              <>
                <span className="fix sm">{s.next.fix}</span>
                <TimeCell printed={printed?.[s.next.fix]} current={s.next.eto} ato={s.next.ato} />
              </>
            )}
          </div>
          <div className="box w1">
            {restriction && (
              <span className="pen restr" title="Time restriction">
                {restriction.kind === 'AT_OR_BEFORE' ? 'B' : restriction.kind === 'AT_OR_AFTER' ? 'A' : '@'}
                {fmtTime(restriction.time)}
              </span>
            )}
          </div>
          <div className="box f">
            {s.prev && (
              <>
                <span className="fix sm">{s.prev.fix}</span>
                <TimeCell printed={printed?.[s.prev.fix]} current={s.prev.eto} ato={s.prev.ato} />
              </>
            )}
          </div>
          <div className="box w2" onDoubleClick={(e) => { e.stopPropagation(); onBox?.('G', s); }} title="Double-click: marks / notes">
            {coordinated && <span className="pen circled" title={`Estimate passed to ${us?.estimateOut?.to}`}>C</span>}
            {marks.map((m) => (
              <span key={m} className="pen mark">{m}</span>
            ))}
            {s.marks.text && <span className="pen note">{s.marks.text}</span>}
            {f.deviation && <span className="pen wx">WX{f.deviation.nm}{f.deviation.side}</span>}
          </div>
          <div className="box h">
            <span className="dof">{f.fpl.dof ?? ''}</span>
            <span className="ptime">{fmtTime(us?.printedAt)}</span>
            <span className="sn">{s.stripNo}</span>
            <span className="tot">{String(s.total).padStart(2, '0')}</span>
            <span className="chev">{s.direction}</span>
          </div>
        </div>
        <div className="row2">
          <span className="adep">{f.fpl.adep}</span>
          <span className="route">{route}</span>
          <span className="ades">{f.fpl.ades}</span>
          <span className="altn">{f.fpl.altn}</span>
          <span className="pbn">{f.pbn ? `PBN/${f.pbn}` : ''}</span>
        </div>
      </div>
      {highlight && (
        <div className={`conflict-badge sev-${highlight.severity.toLowerCase()}`} title={highlight.conflicts.map((c) => c.rule.text).join('\n')}>
          {highlight.severity === 'UNVERIFIED' ? '?' : '⚠'} {partner?.join(' ')}
        </div>
      )}
      {f.emergency && <div className="emerg-badge">EMERG</div>}
    </div>
  );
}
