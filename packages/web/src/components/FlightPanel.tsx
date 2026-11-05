// Flight panel: OCM §8 workflow with phraseology, clearances with a what-if probe,
// estimates, strip marks and the flight's amendment history.
import { useEffect, useMemo, useState } from 'react';
import { machOf, parsePositionReport, parseHHMM, type Command, type Conflict, type Flight } from '@oceanic/core';
import { fmtTime, machText, trajectoryOf } from '../derive.ts';
import { client, useApp, useNow, type UnitConfig } from '../state.ts';

interface Props {
  flight: Flight;
  unit: UnitConfig;
  canEdit: boolean;
  focusFix?: string;
  onClose: () => void;
}

const MARKS = ['✓', '✗', 'Ⓒ', 'R', '⊕', '!', '?'];

function Phrase({ who, text }: { who: 'ATC' | 'PILOT'; text: string }) {
  return (
    <div className={`phrase ${who.toLowerCase()}`} title="Click to copy" onClick={() => navigator.clipboard?.writeText(text)}>
      <span className="who">{who}</span>
      <span>{text}</span>
    </div>
  );
}

function ProbeResult({ result }: { result?: { ok: boolean; error?: string; conflicts?: Conflict[] } | 'busy' }) {
  if (!result) return null;
  if (result === 'busy') return <div className="probe busy">Probing…</div>;
  if (!result.ok) return <div className="probe err">{result.error}</div>;
  if (!result.conflicts?.length) return <div className="probe ok">✓ No conflict predicted</div>;
  return (
    <div className="probe bad">
      {result.conflicts.map((c) => (
        <div key={c.id}>
          <b>{c.severity}</b> with {c.a === result.conflicts![0].a ? c.b : c.a} – {c.rule.text}
          {c.actualMin !== undefined ? ` (actual ${c.actualMin} min)` : c.actualNm !== undefined ? ` (actual ${c.actualNm} NM)` : ''}
        </div>
      ))}
    </div>
  );
}

export function FlightPanel({ flight: f, unit, canEdit, focusFix, onClose }: Props) {
  const app = useApp();
  const now = useNow(5000);
  const us = f.units[unit.id];
  const traj = trajectoryOf(f, now);
  const radio = unit.radioName;
  // level the aircraft is actually flying per ADS-B (rounded to the nearest 1000 ft level)
  const liveFl = f.live && f.category === 'ADSB' && f.live.altitudeFt > 10000 ? Math.round(f.live.altitudeFt / 1000) * 10 : undefined;
  const cs = f.callsign;
  const routeNames = f.route.map((p) => p.name);
  const unitFixes = us ? us.pointIndices.map((i) => f.route[i].name) : routeNames;
  const [err, setErr] = useState('');
  const run = (cmd: Command) => client.command(cmd).then(() => setErr('')).catch((e) => setErr(e.message));

  // --- forms ---
  const [report, setReport] = useState('');
  const parsedReport = useMemo(() => (report.trim() ? parsePositionReport(report, now, routeNames) : null), [report, now, routeNames]);
  const [lvl, setLvl] = useState(String(f.level.cleared));
  const [mach, setMach] = useState(f.mach ? String(Math.round(f.mach * 100)) : '');
  const [restr, setRestr] = useState({ fix: unitFixes[1] ?? unitFixes[0] ?? '', kind: 'AT_OR_BEFORE' as const as 'AT_OR_BEFORE' | 'AT_OR_AFTER' | 'AT', time: '' });
  const [rr, setRr] = useState(f.fpl.route);
  const [wx, setWx] = useState({ nm: '20', side: 'R' as 'L' | 'R' | 'LR' });
  const exitStrip = us ? traj[us.pointIndices[us.pointIndices.length - 1]] : undefined;
  const entryStrip = us ? traj[us.pointIndices[0]] : undefined;
  const [eout, setEout] = useState({ fix: us?.exitFix ?? '', time: fmtTime(exitStrip?.eto), to: us?.nextUnit ?? '' });
  const [ho, setHo] = useState({ to: us?.nextUnit ?? '', freq: '' });
  const [probe, setProbe] = useState<Record<string, { ok: boolean; error?: string; conflicts?: Conflict[] } | 'busy' | undefined>>({});
  const [markFix, setMarkFix] = useState(focusFix ?? unitFixes[0] ?? '');
  const [note, setNote] = useState('');

  useEffect(() => {
    setLvl(String(f.level.cleared));
    setMach(f.mach ? String(Math.round(f.mach * 100)) : '');
    setRr(f.fpl.route);
    setProbe({});
    setReport('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.callsign]);
  useEffect(() => { if (focusFix) setMarkFix(focusFix); }, [focusFix]);
  useEffect(() => {
    setEout({ fix: us?.exitFix ?? '', time: fmtTime(exitStrip?.eto), to: us?.nextUnit ?? '' });
    const n = app.neighbours.find((x) => x.callsign === us?.nextUnit);
    const ind = app.units.find((u) => u.id === us?.nextUnit);
    setHo({ to: us?.nextUnit ?? '', freq: n?.frequency ?? ind?.frequency ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.callsign, us?.exitFix, us?.nextUnit]);

  const doProbe = async (key: string, cmd: Command) => {
    setProbe((p) => ({ ...p, [key]: 'busy' }));
    try {
      const r = await client.whatIf(cmd);
      setProbe((p) => ({ ...p, [key]: r }));
    } catch (e) {
      setProbe((p) => ({ ...p, [key]: { ok: false, error: (e as Error).message } }));
    }
  };

  const levelCmd = (): Command | null => {
    const l = Number(lvl);
    if (!l || l < 50 || l > 600) return null;
    const m = mach ? machOf('M' + mach.replace(/^M?\.?/, '')) : undefined;
    return { type: 'clear_level', callsign: cs, unit: unit.id, level: l, mach: m, reportReaching: true };
  };
  const restrCmd = (): Command | null => {
    const t = parseHHMM(restr.time, now);
    if (t === null || !restr.fix) return null;
    return { type: 'restriction', callsign: cs, unit: unit.id, fix: restr.fix, kind: restr.kind, time: t };
  };
  const rrCmd = (): Command | null => (rr.trim() ? { type: 'reroute', callsign: cs, unit: unit.id, route: rr.trim() } : null);

  const nextUnitName = (id?: string) => app.units.find((u) => u.id === id)?.radioName ?? app.neighbours.find((n) => n.callsign === id)?.name ?? id ?? 'next unit';
  const machWords = (m?: number) => (m ? `Mach decimal ${Math.round(m * 100)}` : '');

  const lvlC = levelCmd();
  const lvlPhrase = lvlC && lvlC.type === 'clear_level'
    ? `${cs}, ${radio}, ${lvlC.level > f.level.cleared ? 'climb to' : lvlC.level < f.level.cleared ? 'descend to' : 'maintain'} FL${lvlC.level}${lvlC.mach ? `, ${lvlC.mach < (f.mach ?? 1) ? 'reduce to' : 'increase to'} Mach ${lvlC.mach.toFixed(2)}` : ''}, report reaching.`
    : '';

  return (
    <aside className="flight-panel">
      <header className="fp-head">
        <div>
          <div className="fp-cs">{cs}{f.emergency && <span className="emerg-chip">EMERGENCY</span>}</div>
          <div className="fp-sub">
            {f.fpl.aircraftType}/{f.fpl.wake} · {f.fpl.adep} → {f.fpl.ades} ({f.fpl.altn || '—'}) · RFL {f.fpl.rfl} · SSR {f.fpl.squawk || '—'} · {f.source}
          </div>
          <div className="fp-sub">
            SELCAL <b>{f.selcal ?? '—'}</b> · PBN {f.pbn ?? '—'} · 10a {f.fpl.equipment || '—'} · 10b {f.fpl.surveillance || '—'}
          </div>
        </div>
        <button className="close" onClick={onClose} title="Close">×</button>
      </header>
      {err && <div className="fp-err" onClick={() => setErr('')}>{err}</div>}
      {f.unresolved.length > 0 && (
        <div className="fp-warn">
          Route items not in the loaded nav data: {f.unresolved.join(' ')}. Normal for parts of the route far outside the Indian Ocean region; check the
          strips if any of these are near Indian oceanic airspace.
        </div>
      )}

      <section>
        <h3>Category <small>OCM §3</small></h3>
        <div className="seg">
          {(['ADSB', 'OTHER', 'AUTO'] as const).map((c) => (
            <button
              key={c}
              disabled={!canEdit}
              className={(c === 'AUTO' ? !f.categoryOverridden : f.categoryOverridden && f.category === c) ? 'on' : ''}
              onClick={() => run({ type: 'set_category', callsign: cs, unit: unit.id, category: c })}
            >
              {c === 'ADSB' ? 'ADS-B' : c === 'OTHER' ? 'Other' : `Auto (${f.categoryAuto === 'ADSB' ? 'ADS-B' : 'Other'})`}
            </button>
          ))}
        </div>
        <p className="hint">
          {f.category === 'ADSB'
            ? 'ADS-B aircraft: 19 NM lateral, 4 min at entry then 15 NM longitudinal. No position reports required.'
            : 'Other aircraft: 60 NM lateral, 10 min same track (Mach Number Technique may reduce), 15 min crossing. Position reports (PTLMEE) required.'}
        </p>
      </section>

      {!us && (
        <section>
          <h3>Not on the {unit.id} board</h3>
          {canEdit && <button onClick={() => run({ type: 'print', callsign: cs, unit: unit.id })}>Print strips</button>}
        </section>
      )}

      {us && (
        <section>
          <h3>
            {unit.radioName} · {us.phase}
            <small> entry {us.entryFix} {fmtTime(entryStrip?.eto)} · exit {us.exitFix} {fmtTime(exitStrip?.eto)}</small>
          </h3>
          {us.estimateIn && <p className="hint">Estimate in: {us.estimateIn.fix} {fmtTime(us.estimateIn.time)} from {us.estimateIn.from || '—'}</p>}

          {us.phase === 'ACTIVE' && canEdit && (
            <div className="row">
              <button onClick={() => run({ type: 'unpost', callsign: cs, unit: unit.id })} title="Posted by mistake? Put the strips back in Printer / Pending (marks and times are kept)">
                ↩ Back to Pending
              </button>
            </div>
          )}
          {us.phase === 'PENDING' && canEdit && (
            <div className="row">
              <button onClick={() => run({ type: 'activate', callsign: cs, unit: unit.id })}>Post strips</button>
              <button onClick={() => run({ type: 'first_contact', callsign: cs, unit: unit.id })}>Pilot called</button>
            </div>
          )}

          {/* Previous unit hand-over, OCM §8 */}
          <div className="phrases">
            <Phrase who="ATC" text={`${cs}, entering oceanic airspace; radar service terminated, report position to ${radio} on ${unit.hf} alias ${unit.frequency}. Jai Hind!`} />
          </div>

          {f.category === 'ADSB' ? (
            <div className="workflow">
              <h4>ADS-B aircraft – OCM §8.1</h4>
              <Phrase who="PILOT" text={`${radio}, ${radio}, ${cs}, FL${f.level.cleared}`} />
              <div className="step">
                <Phrase who="ATC" text={`${cs}, ${radio} Namashkar, FL${liveFl ?? f.level.cleared} copied, report Mach number.`} />
                <button
                  disabled={!canEdit}
                  className={us.contact?.adsbLevel ? 'done' : ''}
                  title={liveFl !== undefined && liveFl !== f.level.cleared ? `ADS-B shows FL${liveFl} – the strip will be corrected from F${f.level.cleared}` : undefined}
                  onClick={() => run({ type: 'adsb_ident', callsign: cs, unit: unit.id, item: 'level', level: liveFl })}
                >
                  FL{liveFl ?? f.level.cleared} copied {us.contact?.adsbLevel ? '✓' : ''}
                </button>
              </div>
              <div className="step">
                <Phrase who="ATC" text={`${cs}, ${machWords(f.mach) || 'Mach …'} copied, standby for SELCAL check.`} />
                <input className="w60" placeholder="Mach" value={mach} onChange={(e) => setMach(e.target.value)} />
                <button
                  disabled={!canEdit}
                  className={us.contact?.adsbMach ? 'done' : ''}
                  onClick={() => run({ type: 'adsb_ident', callsign: cs, unit: unit.id, item: 'mach', mach: machOf('M' + mach.replace(/^M?\.?/, '')) })}
                >
                  Mach copied {us.contact?.adsbMach ? '✓' : ''}
                </button>
              </div>
              <div className="step">
                <Phrase who="PILOT" text={`SELCAL check OK, ${cs}`} />
                <button disabled={!canEdit} className={us.contact?.selcal ? 'done' : ''} onClick={() => run({ type: 'selcal_ok', callsign: cs, unit: unit.id })}>
                  SELCAL OK {us.contact?.selcal ? '✓' : ''}
                </button>
              </div>
              <Phrase who="ATC" text={`${cs}, remain on SELCAL watch, no position reports required.`} />
            </div>
          ) : (
            <div className="workflow">
              <h4>Other aircraft – OCM §8.2 (PTLMEE)</h4>
              <Phrase who="PILOT" text={`${radio}, ${radio}, ${cs}, with position.`} />
              <div className="step col">
                <label>Position report: Position · Time · Level · Mach · Estimate next · Next after</label>
                <div className="row">
                  <input
                    className="grow mono"
                    placeholder={`${us.entryFix} ${fmtTime(entryStrip?.eto)} F${f.level.cleared} M${String(Math.round((f.mach ?? 0.8) * 100)).padStart(3, '0')} ${unitFixes[1] ?? ''} ${fmtTime(traj[us.pointIndices[1]]?.eto)} ${unitFixes[2] ?? ''}`}
                    value={report}
                    disabled={!canEdit}
                    onChange={(e) => setReport(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && parsedReport && typeof parsedReport !== 'string') {
                        run({ type: 'report', callsign: cs, unit: unit.id, ...parsedReport, raw: report }).then(() => setReport(''));
                      }
                    }}
                  />
                  <button
                    disabled={!canEdit || !parsedReport || typeof parsedReport === 'string'}
                    onClick={() => parsedReport && typeof parsedReport !== 'string' && run({ type: 'report', callsign: cs, unit: unit.id, ...parsedReport, raw: report }).then(() => setReport(''))}
                  >
                    Copy report
                  </button>
                </div>
                {typeof parsedReport === 'string' && <div className="probe err">{parsedReport}</div>}
                {parsedReport && typeof parsedReport !== 'string' && (
                  <Phrase
                    who="ATC"
                    text={`${cs}, ${radio}, position ${parsedReport.fix} at ${fmtTime(parsedReport.time)} Zulu${parsedReport.level ? `, FL${parsedReport.level}` : ''}.${parsedReport.nextFix ? ` Estimating ${parsedReport.nextFix} at ${fmtTime(parsedReport.nextTime)} Zulu` : ''}${parsedReport.thenFix ? `, ${parsedReport.thenFix} thereafter` : ''}.${parsedReport.mach ? ` ${machWords(parsedReport.mach)}` : ''}${us.contact?.selcal ? '' : ', standby for SELCAL check'}.`}
                  />
                )}
              </div>
              <div className="step">
                <Phrase who="PILOT" text={`Readback correct, checking SELCAL${f.selcal ? ` ${f.selcal.slice(0, 2)}-${f.selcal.slice(2)}` : ''}, ${cs}. SELCAL check OK.`} />
                <button disabled={!canEdit} className={us.contact?.selcal ? 'done' : ''} onClick={() => run({ type: 'selcal_ok', callsign: cs, unit: unit.id })}>
                  SELCAL OK {us.contact?.selcal ? '✓' : ''}
                </button>
              </div>
              <div className="step">
                <Phrase who="ATC" text={`${cs}, roger, remain on SELCAL watch, report overhead ${us.nextReportFix ?? '…'}.`} />
                <select disabled={!canEdit} value={us.nextReportFix ?? ''} onChange={(e) => run({ type: 'next_report', callsign: cs, unit: unit.id, fix: e.target.value })}>
                  <option value="">next report…</option>
                  {unitFixes.map((x) => <option key={x}>{x}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="workflow">
            <h4>Leaving oceanic airspace</h4>
            <div className="step">
              <input className="w70 mono" value={eout.fix} onChange={(e) => setEout({ ...eout, fix: e.target.value.toUpperCase() })} />
              <input className="w60 mono" value={eout.time} onChange={(e) => setEout({ ...eout, time: e.target.value })} />
              <input className="w120 mono" list="neighbours" placeholder="to unit" value={eout.to} onChange={(e) => setEout({ ...eout, to: e.target.value.toUpperCase() })} />
              <button
                disabled={!canEdit}
                className={us.estimateOut ? 'done' : 'primary'}
                onClick={() => {
                  const t = parseHHMM(eout.time, now);
                  if (t === null) return setErr('Invalid time');
                  run({ type: 'estimate_out', callsign: cs, unit: unit.id, fix: eout.fix, time: t, to: eout.to });
                }}
              >
                Pass estimate {us.estimateOut ? `✓ ${fmtTime(us.estimateOut.at)}` : ''}
              </button>
            </div>
            <Phrase who="ATC" text={`${cs}, position ${us.exitFix}, leaving oceanic airspace, contact ${nextUnitName(ho.to)}${ho.freq ? ` ${ho.freq}` : ''}.`} />
            <div className="step">
              <input className="w120 mono" list="neighbours" placeholder="position" value={ho.to} onChange={(e) => {
                const v = e.target.value.toUpperCase();
                const n = app.neighbours.find((x) => x.callsign === v);
                const ind = app.units.find((u) => u.id === v);
                setHo({ to: v, freq: n?.frequency ?? ind?.frequency ?? ho.freq });
              }} />
              <input className="w70 mono" placeholder="freq" value={ho.freq} onChange={(e) => setHo({ ...ho, freq: e.target.value })} />
              <button disabled={!canEdit || us.phase === 'HANDED_OFF'} onClick={() => run({ type: 'handoff', callsign: cs, unit: unit.id, to: ho.to, freq: ho.freq })}>
                Hand off
              </button>
              {us.phase === 'HANDED_OFF' && canEdit && <button onClick={() => run({ type: 'activate', callsign: cs, unit: unit.id })}>Recall</button>}
            </div>
            <datalist id="neighbours">
              {app.units.filter((u) => u.id !== unit.id).map((u) => <option key={u.id} value={u.id}>{u.radioName} {u.frequency}</option>)}
              {app.neighbours.map((n) => <option key={n.callsign} value={n.callsign}>{n.name} {n.frequency}</option>)}
            </datalist>
          </div>
        </section>
      )}

      <section>
        <h3>Clearances <small>what-if probed before issue</small></h3>
        <div className="clr">
          <h4>Level &amp; Mach <small>OCM §8.3.1</small></h4>
          <div className="row">
            <label>FL</label>
            <input className="w60 mono" value={lvl} onChange={(e) => setLvl(e.target.value.replace(/\D/g, ''))} />
            <label>Mach</label>
            <input className="w60 mono" placeholder="079" value={mach} onChange={(e) => setMach(e.target.value)} />
            <button onClick={() => { const c = levelCmd(); if (c) doProbe('lvl', c); }}>Probe</button>
            <button disabled={!canEdit || !lvlC} className="primary" onClick={() => lvlC && run(lvlC)}>Issue</button>
            {!f.level.confirmed && f.level.previous !== undefined && canEdit && (
              <button onClick={() => run({ type: 'level_reached', callsign: cs, unit: unit.id })}>Reaching ✓</button>
            )}
          </div>
          <ProbeResult result={probe.lvl} />
          {lvlPhrase && <Phrase who="ATC" text={lvlPhrase} />}
        </div>

        <div className="clr">
          <h4>Time restriction <small>OCM §8.3.2</small></h4>
          <div className="row">
            <select value={restr.kind} onChange={(e) => setRestr({ ...restr, kind: e.target.value as typeof restr.kind })}>
              <option value="AT_OR_BEFORE">at or before</option>
              <option value="AT_OR_AFTER">after</option>
              <option value="AT">at</option>
            </select>
            <select value={restr.fix} onChange={(e) => setRestr({ ...restr, fix: e.target.value })}>
              {unitFixes.map((x) => <option key={x}>{x}</option>)}
            </select>
            <input className="w60 mono" placeholder="hhmm" value={restr.time} onChange={(e) => setRestr({ ...restr, time: e.target.value })} />
            <button onClick={() => { const c = restrCmd(); if (c) doProbe('restr', c); }}>Probe</button>
            <button disabled={!canEdit || !restrCmd()} className="primary" onClick={() => { const c = restrCmd(); if (c) run(c); }}>Issue</button>
            {f.restrictions.length > 0 && canEdit && <button onClick={() => run({ type: 'clear_restrictions', callsign: cs, unit: unit.id })}>Cancel all</button>}
          </div>
          <ProbeResult result={probe.restr} />
          {restr.time && <Phrase who="ATC" text={`${cs}, ${radio}, cross ${restr.fix} ${restr.kind === 'AT_OR_BEFORE' ? 'at or before' : restr.kind === 'AT_OR_AFTER' ? 'after' : 'at'} ${restr.time}z.`} />}
        </div>

        <div className="clr">
          <h4>Reroute <small>OCM §8.3.3</small></h4>
          <textarea className="mono" rows={2} value={rr} onChange={(e) => setRr(e.target.value.toUpperCase())} />
          <div className="row">
            <button onClick={() => { const c = rrCmd(); if (c) doProbe('rr', c); }}>Probe</button>
            <button disabled={!canEdit} className="primary" onClick={() => { const c = rrCmd(); if (c) run(c); }}>Issue</button>
          </div>
          <ProbeResult result={probe.rr} />
          <Phrase who="ATC" text={`${cs}, ${radio}, reroute due to traffic, report ready to copy.`} />
          <Phrase who="ATC" text={`${cs}, ${radio}, recleared ${f.fpl.ades} via ${rr.trim().split(/\s+/).filter((t) => !/^[NMK]\d{3,4}/.test(t) && t !== 'DCT').slice(0, 6).join(', ')}.`} />
        </div>

        <div className="clr">
          <h4>Weather deviation <small>OCM §8.3.5</small></h4>
          <div className="row">
            <input className="w60 mono" value={wx.nm} onChange={(e) => setWx({ ...wx, nm: e.target.value.replace(/\D/g, '') })} />
            <span>NM</span>
            <select value={wx.side} onChange={(e) => setWx({ ...wx, side: e.target.value as typeof wx.side })}>
              <option value="L">left</option>
              <option value="R">right</option>
              <option value="LR">either side</option>
            </select>
            <button disabled={!canEdit} onClick={() => doProbe('wx', { type: 'deviation', callsign: cs, unit: unit.id, nm: Number(wx.nm), side: wx.side })}>Probe</button>
            <button disabled={!canEdit} className="primary" onClick={() => run({ type: 'deviation', callsign: cs, unit: unit.id, nm: Number(wx.nm), side: wx.side })}>Approve</button>
            {f.deviation && canEdit && <button onClick={() => run({ type: 'deviation_end', callsign: cs, unit: unit.id })}>Back on track</button>}
          </div>
          <ProbeResult result={probe.wx} />
          <p className="hint">If unable: “UNABLE (requested deviation), TRAFFIC IS (call-sign, position, level, direction), ADVISE INTENTIONS”.</p>
        </div>

        <div className="clr">
          <h4>Emergency <small>OCM §8.3.4</small></h4>
          <div className="row">
            <button disabled={!canEdit} className={f.emergency ? 'danger on' : 'danger'} onClick={() => run({ type: 'emergency', callsign: cs, unit: unit.id, on: !f.emergency })}>
              {f.emergency ? 'Cancel emergency' : 'MAYDAY / PAN PAN received'}
            </button>
          </div>
          <p className="hint">Do not instruct squawk 7700. Reroute as required; the pilot reports estimates for each waypoint.</p>
        </div>
      </section>

      <section>
        <h3>Estimates</h3>
        <table className="eto-table">
          <thead>
            <tr><th>Fix</th><th>Route</th><th>ETO</th><th>Src</th><th>ATO</th><th /></tr>
          </thead>
          <tbody>
            {traj.filter((p) => !p.isAirport).map((p) => {
              const inUnit = us?.pointIndices.includes(p.index);
              return (
                <tr key={p.index} className={`${inUnit ? 'in-unit' : ''} ${p.passed ? 'passed' : ''}`}>
                  <td>{p.name}</td>
                  <td>{p.airway ?? 'DCT'}</td>
                  <td>{fmtTime(p.eto)}</td>
                  <td className={`src-${(p.source ?? '').toLowerCase()}`}>{p.source ?? ''}</td>
                  <td>{p.ato !== undefined ? fmtTime(p.ato) : ''}</td>
                  <td>
                    {canEdit && inUnit && p.ato === undefined && (
                      <button
                        className="mini"
                        onClick={() => {
                          const v = prompt(`Revised estimate for ${p.name} (hhmm)`, fmtTime(p.eto));
                          const t = v ? parseHHMM(v, now) : null;
                          if (t !== null) run({ type: 'estimate', callsign: cs, unit: unit.id, fix: p.name, time: t, source: 'CTRL' });
                        }}
                      >
                        rev
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="hint">ATO › pilot / coordinated / controller estimate › calculated (Mach {machText(f.mach) || 'from filed speed'}, ISA, no wind).</p>
      </section>

      {us && (
        <section>
          <h3>Strip marks</h3>
          <div className="row">
            <select value={markFix} onChange={(e) => setMarkFix(e.target.value)}>
              {unitFixes.map((x) => <option key={x}>{x}</option>)}
            </select>
            {MARKS.map((m) => {
              const on = us.marks[markFix]?.symbols?.includes(m);
              return (
                <button key={m} disabled={!canEdit} className={`mark-btn ${on ? 'on' : ''}`} onClick={() => run({ type: 'mark', callsign: cs, unit: unit.id, fix: markFix, symbol: m, on: !on })}>
                  {m}
                </button>
              );
            })}
          </div>
          <div className="row">
            <input className="grow" placeholder={us.marks[markFix]?.text ?? 'note on strip'} value={note} onChange={(e) => setNote(e.target.value)} />
            <button disabled={!canEdit} onClick={() => run({ type: 'free_text', callsign: cs, unit: unit.id, fix: markFix, text: note }).then(() => setNote(''))}>Write</button>
          </div>
          {canEdit && (
            <div className="row">
              <button onClick={() => { if (confirm(`Remove all ${unit.id} strips for ${cs}?`)) run({ type: 'remove', callsign: cs, unit: unit.id }); }}>Remove strips</button>
            </div>
          )}
        </section>
      )}

      <section>
        <h3>History</h3>
        <ul className="history">
          {[...f.history].reverse().slice(0, 60).map((h, i) => (
            <li key={i}>
              <span className="t">{fmtTime(h.at)}</span>
              {h.unit && <span className="u">{h.unit}</span>}
              <span className="k">{h.kind}</span>
              <span>{h.text}</span>
              {h.by && <span className="by">{h.by}</span>}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
