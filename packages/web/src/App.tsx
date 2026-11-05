import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMAND_HELP, parseCommandLine, parseHHMM, parsePositionReport, type FixStrip, type Flight } from '@oceanic/core';
import { Board } from './components/Board.tsx';
import { FlightPanel } from './components/FlightPanel.tsx';
import { Modal, type Field } from './components/Modal.tsx';
import { AuditLog, ConflictList, CoordLog, RadioInbox } from './components/SidePanels.tsx';
import { SituationDisplay } from './components/SituationDisplay.tsx';
import { buildBoard, fmtTime, trajectoryOf } from './derive.ts';
import { client, unitById, useApp, useNow, type User } from './state.ts';

function Login() {
  const app = useApp();
  const [cid, setCid] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="login">
      <div className="login-card">
        <h1>Indian Oceanic Strips</h1>
        <p className="sub">{app.units.length ? app.units.map((u) => `${u.radioName} (${u.id})`).join(' · ') : 'Mumbai · Chennai · Kolkata Radio'} · VATSIM</p>
        {app.authMode === 'vatsim' ? (
          <a className="btn primary" href="/auth/vatsim">Log in with VATSIM</a>
        ) : (
          <>
            <label>VATSIM CID<input value={cid} onChange={(e) => setCid(e.target.value.replace(/\D/g, ''))} /></label>
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && client.loginLocal(cid, name).catch((x) => setErr(x.message))} /></label>
            <button className="primary" onClick={() => client.loginLocal(cid, name).catch((x) => setErr(x.message))}>Log in</button>
            <p className="hint">Local login (no password) – for a server on your own PC or for training. Set VATSIM_CLIENT_ID to use VATSIM Connect.</p>
          </>
        )}
        {err && <div className="fp-err">{err}</div>}
        <p className="disclaimer">For use on the VATSIM network only. Not for real-world aviation.</p>
      </div>
    </div>
  );
}

function PositionSelect() {
  const app = useApp();
  const [err, setErr] = useState('');
  const taken = (unit: string) => app.status?.positions.find((p) => p.unit === unit && p.role === 'CONTROLLER');
  const join = (unit: string, role: NonNullable<User['role']>) => client.join(unit, role).catch((e) => setErr(e.message));
  return (
    <div className="login">
      <div className="login-card wide">
        <h1>Select position</h1>
        <p className="sub">Logged in as {app.user?.name} ({app.user?.cid}) · AIRAC {app.airac}</p>
        {(app.setupProblems?.length ?? 0) > 0 && (
          <div className="setup-problems inline">
            <b>Set-up problem:</b>
            <ul>{app.setupProblems!.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        <div className="positions">
          {app.units.map((u) => (
            <div key={u.id} className="pos-card">
              <h2>{u.radioName}</h2>
              <div className="sub">{u.name} · {u.id} · {u.frequency} (HF {[u.hf, ...(u.hfSecondary ?? [])].join(' / ')})</div>
              <div className="row">
                <button className="primary" onClick={() => join(u.id, 'CONTROLLER')} disabled={!!taken(u.id) && taken(u.id)!.cid !== app.user?.cid}>
                  Controller{taken(u.id) ? ` (${taken(u.id)!.name})` : ''}
                </button>
                <button onClick={() => join(u.id, 'COORDINATOR')}>Coordinator</button>
                <button onClick={() => join(u.id, 'OBSERVER')}>Observer</button>
              </div>
            </div>
          ))}
        </div>
        {err && <div className="fp-err">{err}</div>}
        <button className="link" onClick={() => client.logout()}>Log out</button>
      </div>
    </div>
  );
}

function Clock() {
  const now = useNow(1000);
  const d = new Date(now);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return (
    <div className="utc">
      {hh}:{mm}<small>:{ss}</small> <span>UTC</span>
    </div>
  );
}

type Tab = 'conflicts' | 'radio' | 'coord' | 'map' | 'log' | 'help';

export function App() {
  const app = useApp();
  useEffect(() => { client.init(); }, []);
  if (app.phase === 'loading') return <div className="splash">Loading…</div>;
  if (app.phase === 'login') return <Login />;
  if (!app.user?.unit) return app.phase === 'ready' ? <PositionSelect /> : <div className="splash">Connecting…</div>;
  return <Main />;
}

function Main() {
  const app = useApp();
  const now = useNow(2000);
  const unit = unitById(app.units, app.user?.unit)!;
  const canEdit = app.user?.role === 'CONTROLLER' || app.user?.role === 'COORDINATOR';
  const [selected, setSelected] = useState<{ cs: string; fix?: string }>();
  const [tab, setTab] = useState<Tab>('conflicts');
  const [zoom, setZoom] = useState(() => Number(localStorageGet('strip-zoom') ?? '1'));
  const [modal, setModal] = useState<null | { title: string; fields: Field[]; hint?: string; submit: (v: Record<string, string>) => Promise<void> }>(null);
  const [cmd, setCmd] = useState('');
  const [cmdMsg, setCmdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const cmdRef = useRef<HTMLInputElement>(null);

  const overdueMin = app.rules?.overdueMin ?? 3;
  const board = useMemo(() => buildBoard(app.flights, unit, now, overdueMin), [app.flights, unit, now, overdueMin]);
  // only conflicts inside (or on the boundary of) this unit's airspace are this unit's
  const myConflicts = app.conflicts.filter((c) => c.units.includes(unit.id));
  const los = myConflicts.filter((c) => c.severity === 'LOS' && !c.acknowledged).length;
  const warn = myConflicts.filter((c) => c.severity !== 'LOS').length;
  const unhandledRadio = app.radio.filter((r) => r.unit === unit.id && !r.handled).length;
  const flight = selected ? app.flights.get(selected.cs) : undefined;

  useEffect(() => { localStorageSet('strip-zoom', String(zoom)); }, [zoom]);
  // opened from the EuroScope tag function: ?flight=CALLSIGN
  useEffect(() => {
    const cs = new URLSearchParams(location.search).get('flight');
    if (cs) setSelected({ cs: cs.toUpperCase() });
  }, []);
  const [scenarios, setScenarios] = useState<string[]>([]);
  useEffect(() => {
    if (app.status?.source === 'sim') fetch('/api/scenarios').then((r) => r.json()).then(setScenarios).catch(() => undefined);
  }, [app.status?.source]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(undefined);
      if ((e.key === '/' || e.key === 'F2') && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        cmdRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const neighbourList = (
    <datalist id="nb-list">
      {app.units.filter((u) => u.id !== unit.id).map((u) => <option key={u.id} value={u.id}>{u.radioName}</option>)}
      {app.neighbours.map((n) => <option key={n.callsign} value={n.callsign}>{n.name} {n.frequency}</option>)}
    </datalist>
  );

  const estimateIn = (f: Flight) => {
    const us = f.units[unit.id];
    const traj = trajectoryOf(f, now);
    const entry = traj[us.pointIndices[0]];
    setModal({
      title: `${f.callsign} – estimate received`,
      fields: [
        { key: 'fix', label: 'Fix', value: us.entryFix },
        { key: 'time', label: 'Time', value: fmtTime(entry?.eto) },
        { key: 'from', label: 'From', value: us.prevUnit ?? '', list: 'nb-list' },
      ],
      hint: 'Coordinated estimate from the transferring unit (LoA). Strips are posted on the board.',
      submit: async (v) => {
        const t = parseHHMM(v.time, client.now());
        if (t === null) throw new Error('Invalid time');
        await client.command({ type: 'estimate_in', callsign: f.callsign, unit: unit.id, fix: v.fix, time: t, from: v.from });
      },
    });
  };
  const estimateOut = (f: Flight) => {
    const us = f.units[unit.id];
    const traj = trajectoryOf(f, now);
    const exit = traj[us.pointIndices[us.pointIndices.length - 1]];
    setModal({
      title: `${f.callsign} – pass estimate`,
      fields: [
        { key: 'fix', label: 'Fix', value: us.exitFix },
        { key: 'time', label: 'Time', value: fmtTime(exit?.eto) },
        { key: 'to', label: 'To', value: us.nextUnit ?? '', list: 'nb-list' },
      ],
      hint: `${f.callsign} ${us.exitFix} ${fmtTime(exit?.eto)} F${f.level.cleared}${f.mach ? ` M${Math.round(f.mach * 100)}` : ''}${f.selcal ? ` SELCAL ${f.selcal}` : ''}`,
      submit: async (v) => {
        const t = parseHHMM(v.time, client.now());
        if (t === null) throw new Error('Invalid time');
        await client.command({ type: 'estimate_out', callsign: f.callsign, unit: unit.id, fix: v.fix, time: t, to: v.to });
      },
    });
  };
  const onBox = (box: 'A' | 'B' | 'G' | 'E', s: FixStrip) => {
    const f = app.flights.get(s.callsign);
    if (!f) return;
    const names = f.route.map((p) => p.name);
    if (box === 'A') {
      const traj = trajectoryOf(f, now);
      const nx = traj[s.index + 1], th = traj[s.index + 2];
      setModal({
        title: `${f.callsign} – over ${s.fix}`,
        fields: [{ key: 'r', label: 'Report', wide: true, value: `${s.fix} ${fmtTime(Math.min(now, s.eto ?? now))} F${f.level.cleared}${f.mach ? ` M${String(Math.round(f.mach * 100)).padStart(3, '0')}` : ''}${nx && !nx.isAirport ? ` ${nx.name} ${fmtTime(nx.eto)}` : ''}${th && !th.isAirport ? ` ${th.name}` : ''}` }],
        hint: 'PTLMEE: Position Time Level Mach Estimate-next Next-after. Leave only "FIX HHMM" to write the time over.',
        submit: async (v) => {
          const r = parsePositionReport(v.r, client.now(), names);
          if (typeof r === 'string') throw new Error(r);
          await client.command({ type: 'report', callsign: f.callsign, unit: unit.id, ...r, raw: v.r });
        },
      });
    } else if (box === 'E' && s.next) {
      setModal({
        title: `${f.callsign} – revise ${s.next.fix}`,
        fields: [{ key: 't', label: 'Estimate', value: fmtTime(s.next.eto) }],
        submit: async (v) => {
          const t = parseHHMM(v.t, client.now());
          if (t === null) throw new Error('Invalid time');
          await client.command({ type: 'estimate', callsign: f.callsign, unit: unit.id, fix: s.next!.fix, time: t, source: 'CTRL' });
        },
      });
    } else if (box === 'B') {
      setSelected({ cs: f.callsign, fix: s.fix });
    } else {
      setSelected({ cs: f.callsign, fix: s.fix });
    }
  };

  const runCmd = async () => {
    const line = cmd.trim();
    if (!line) return;
    if (line.toUpperCase() === 'HELP') { setTab('help'); setCmd(''); return; }
    const parsed = parseCommandLine(line, unit.id, client.now(), (cs) => app.flights.get(cs)?.route.map((p) => p.name));
    if (typeof parsed === 'string') { setCmdMsg({ ok: false, text: parsed }); return; }
    try {
      await client.command(parsed);
      setCmdMsg({ ok: true, text: `${parsed.type.replace('_', ' ')} ${'callsign' in parsed ? parsed.callsign : ''} ✓` });
      setCmd('');
      if ('callsign' in parsed) setSelected({ cs: parsed.callsign });
    } catch (e) {
      setCmdMsg({ ok: false, text: (e as Error).message });
    }
  };

  const st = app.status;
  const feedAge = st?.feed?.lastOk ? Math.round((Date.now() - st.feed.lastOk) / 1000) : undefined;

  return (
    <div className={`app ${flight ? 'with-panel' : ''}`} style={{ ['--zoom' as string]: zoom }}>
      {neighbourList}
      <header className="topbar">
        <div className="unit">
          <div className="radio">{unit.radioName}</div>
          <div className="sub">{unit.id} · {unit.frequency} · HF {[unit.hf, ...(unit.hfSecondary ?? [])].join(' / ')} · {app.user?.role?.toLowerCase()}</div>
        </div>
        <Clock />
        <div className={`alerts ${los ? 'los' : ''}`} onClick={() => setTab('conflicts')}>
          <span className="n-los">{los}</span> LOS
          <span className="n-warn">{warn}</span> other
        </div>
        <div className="status">
          <span className={`dot ${app.phase === 'ready' ? 'ok' : 'bad'}`} /> server
          {st?.source === 'vatsim' && <span className={feedAge !== undefined && feedAge < 60 ? 'ok' : 'bad'}> · VATSIM feed {feedAge !== undefined ? `${feedAge}s` : '…'}</span>}
          {st?.source === 'sim' && <span className="ok"> · SIM {st.sim?.scenario} ×{st.clock.scale}</span>}
          <span className={st?.plugins.some((p) => p.unit === unit.id) ? 'ok' : 'muted'}> · ES {st?.plugins.length ? st.plugins.map((p) => p.controller).join(',') : 'off'}</span>
          <span className="muted"> · {board.stripCount} strips · </span>
          {app.airacCurrent && app.airac && app.airac < app.airacCurrent ? (
            <span className="bad" title={`Installed sector files are AIRAC ${app.airac}; ${app.airacCurrent} is current. Install the new VABF/VOMF/VECF files from AeroNav GNG into "Sector files" (any folder name) and restart the server.`}>
              AIRAC {app.airac} – {app.airacCurrent} current
            </span>
          ) : (
            <span className="muted">AIRAC {app.airac}</span>
          )}
        </div>
        <div className="tools">
          {st?.source === 'sim' && scenarios.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value && confirm(`Load scenario ${e.target.value}? All strips are cleared.`)) client.simControl({ scenario: e.target.value }); }}
              title="Training scenario"
            >
              <option value="">Scenario…</option>
              {scenarios.map((x) => <option key={x} value={x}>{x.replace('.json', '')}</option>)}
            </select>
          )}
          {st?.source === 'sim' && (
            <select value={st.clock.scale} onChange={(e) => client.simControl({ scale: Number(e.target.value) })} title="Simulation speed">
              {[0, 1, 2, 4, 8].map((x) => <option key={x} value={x}>{x === 0 ? 'Pause' : `×${x}`}</option>)}
            </select>
          )}
          <label title="Strip size">
            <input type="range" min={0.7} max={1.4} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <button onClick={() => client.leave()} title="Change position">
            {app.user?.name} ⇄
          </button>
          <button onClick={() => client.logout()}>Log out</button>
        </div>
      </header>
      {(app.setupProblems?.length ?? 0) > 0 && (
        <div className="setup-problems">
          <b>Set-up problem – strips may be missing:</b>
          <ul>{app.setupProblems!.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      <main className="main">
        <Board
          board={board}
          unit={unit}
          conflicts={myConflicts}
          selected={selected?.cs}
          canEdit={canEdit}
          onSelect={(cs, fix) => setSelected({ cs, fix })}
          onBox={onBox}
          onEstimateIn={estimateIn}
          onEstimateOut={estimateOut}
        />
        <aside className="side">
          <nav className="tabs">
            <button className={tab === 'conflicts' ? 'on' : ''} onClick={() => setTab('conflicts')}>Conflicts {myConflicts.length ? <b className={los ? 'b-los' : 'b-warn'}>{myConflicts.length}</b> : null}</button>
            <button className={tab === 'radio' ? 'on' : ''} onClick={() => setTab('radio')}>HF {unhandledRadio ? <b className="b-radio">{unhandledRadio}</b> : null}</button>
            <button className={tab === 'coord' ? 'on' : ''} onClick={() => setTab('coord')}>Coord</button>
            <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>Map</button>
            <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
            <button className={tab === 'help' ? 'on' : ''} onClick={() => setTab('help')}>?</button>
          </nav>
          <div className="tab-body">
            {tab === 'conflicts' && <ConflictList conflicts={app.conflicts} unit={unit} canAck={canEdit} onSelect={(cs) => setSelected({ cs })} />}
            {tab === 'radio' && <RadioInbox radio={app.radio} unit={unit} canEdit={canEdit} onSelect={(cs) => setSelected({ cs })} />}
            {tab === 'coord' && <CoordLog coord={app.coord} unit={unit} />}
            {tab === 'map' && <SituationDisplay app={app} unit={unit} now={now} selected={selected?.cs} conflicts={app.conflicts} onSelect={(cs) => setSelected({ cs })} />}
            {tab === 'log' && <AuditLog />}
            {tab === 'help' && <Help />}
          </div>
        </aside>
        {flight && <FlightPanel flight={flight} unit={unit} canEdit={canEdit} focusFix={selected?.fix} onClose={() => setSelected(undefined)} />}
      </main>

      <footer className="cmdline">
        <span className="prompt">{unit.id}&gt;</span>
        <input
          ref={cmdRef}
          className="mono"
          placeholder="QTR8E R KITAL 0053 F350 M083 BOLUR 0123 DONSA   ·   press / to focus   ·   HELP"
          value={cmd}
          disabled={!canEdit}
          onChange={(e) => { setCmd(e.target.value.toUpperCase()); setCmdMsg(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') runCmd(); if (e.key === 'Escape') { setCmd(''); cmdRef.current?.blur(); } }}
        />
        {cmdMsg && <span className={`cmd-msg ${cmdMsg.ok ? 'ok' : 'bad'}`}>{cmdMsg.text}</span>}
      </footer>

      {modal && <Modal title={modal.title} fields={modal.fields} hint={modal.hint} onSubmit={modal.submit} onClose={() => setModal(null)} />}
    </div>
  );
}

function Help() {
  return (
    <div className="panel-list help">
      <h4>Command line</h4>
      <table>
        <tbody>
          {COMMAND_HELP.map(([c, d]) => (
            <tr key={c}><td className="mono">{c}</td><td>{d}</td></tr>
          ))}
        </tbody>
      </table>
      <h4>Strip</h4>
      <p>Box A fix + estimate (double-click to write a report). Box B level (✓ = confirmed). Box C flight. Next / previous fix boxes. Pen (blue) = controller entries; struck-through = superseded printed value. Ⓒ on the exit strip = estimate passed. R = next report required. Chevron &gt; eastbound, &lt; westbound.</p>
      <h4>Highlights</h4>
      <p><span className="sw los" /> loss of separation predicted · <span className="sw warn" /> within buffer of the minimum · <span className="sw unv" /> report overdue, cannot verify.</p>
      <h4>Separation (OCM §6)</h4>
      <p>Vertical 1000 ft (2000 ft above FL410). Lateral 19 NM ADS-B / 60 NM other. Longitudinal ADS-B 4 min at entry then 15 NM; other 10 min same track (MNT 9–5 min), 15 min crossing. India–Oman LoA at Muscat TCPs.</p>
    </div>
  );
}

function localStorageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
