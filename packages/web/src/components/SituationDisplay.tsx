// Plan view of the oceanic airspace. ADS-B aircraft are shown from live data
// (backup surveillance only, OCM §2); procedural aircraft are shown as hollow
// "estimated" symbols positioned from their strip estimates.
import { useMemo, useRef, useState } from 'react';
import { positionAt, type Flight } from '@oceanic/core';
import { trajectoryOf } from '../derive.ts';
import type { AppState, BoardConflict, UnitConfig } from '../state.ts';

interface Props {
  app: AppState;
  unit: UnitConfig;
  now: number;
  selected?: string;
  conflicts: BoardConflict[];
  onSelect: (cs: string) => void;
}

const PAD = 2;

export function SituationDisplay({ app, unit, now, selected, conflicts, onSelect }: Props) {
  const air = app.airspaces.find((a) => a.id === unit.id);
  const bounds = useMemo(() => {
    const pts = (air?.polygons ?? []).flat();
    if (!pts.length) return { minLat: -10, maxLat: 25, minLon: 55, maxLon: 100 };
    return {
      minLat: Math.min(...pts.map((p) => p.lat)) - PAD,
      maxLat: Math.max(...pts.map((p) => p.lat)) + PAD,
      minLon: Math.min(...pts.map((p) => p.lon)) - PAD,
      maxLon: Math.max(...pts.map((p) => p.lon)) + PAD,
    };
  }, [air]);
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const X = (lon: number) => (lon - bounds.minLon) * k * 10;
  const Y = (lat: number) => (bounds.maxLat - lat) * 10;
  const W = (bounds.maxLon - bounds.minLon) * k * 10;
  const H = (bounds.maxLat - bounds.minLat) * 10;
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const inView = (lat: number, lon: number) => lat >= bounds.minLat - 3 && lat <= bounds.maxLat + 3 && lon >= bounds.minLon - 3 && lon <= bounds.maxLon + 3;

  const flights = [...app.flights.values()].filter((f) => f.units[unit.id] && f.units[unit.id].phase !== 'HANDED_OFF');
  const conflictPairs = conflicts.filter((c) => c.units.includes(unit.id));
  const s = view.w / 120; // symbol scale

  const symbol = (f: Flight) => {
    const traj = trajectoryOf(f, now);
    const est = positionAt(traj, now);
    const live = f.live && f.category === 'ADSB' ? f.live : undefined;
    const p = live ?? est;
    if (!p || !inView(p.lat, p.lon)) return null;
    const hl = conflicts.find((c) => c.a === f.callsign || c.b === f.callsign);
    const cls = `ac ${live ? 'adsb' : 'proc'} ${hl ? `sev-${hl.severity.toLowerCase()}` : ''} ${selected === f.callsign ? 'sel' : ''}`;
    return (
      <g key={f.callsign} className={cls} onClick={() => onSelect(f.callsign)} transform={`translate(${X(p.lon)},${Y(p.lat)})`}>
        {live ? <rect x={-s} y={-s} width={2 * s} height={2 * s} /> : <circle r={s * 1.2} />}
        <text x={s * 1.8} y={-s * 0.4} fontSize={s * 2.2}>{f.callsign}</text>
        <text x={s * 1.8} y={s * 2} fontSize={s * 1.8} className="lbl2">
          F{f.level.cleared}{!f.level.confirmed && f.level.previous !== undefined ? (f.level.cleared > f.level.previous ? '↑' : '↓') : ''} {live ? 'ADS-B' : 'EST'}
        </text>
      </g>
    );
  };

  return (
    <div className="sitdisp">
      <div className="sd-legend">
        <span><i className="lg adsb" /> ADS-B (backup surveillance)</span>
        <span><i className="lg proc" /> procedural – estimated from strips</span>
        <button className="mini" onClick={() => setView({ x: 0, y: 0, w: W, h: H })}>Reset</button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onWheel={(e) => {
          const r = svgRef.current!.getBoundingClientRect();
          const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
          const z = e.deltaY > 0 ? 1.15 : 1 / 1.15;
          const nw = Math.min(W * 2, Math.max(20, view.w * z)), nh = (nw / view.w) * view.h;
          setView({ x: view.x + (view.w - nw) * fx, y: view.y + (view.h - nh) * fy, w: nw, h: nh });
        }}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          const r = svgRef.current!.getBoundingClientRect();
          setView({ ...view, x: drag.current.vx - ((e.clientX - drag.current.x) / r.width) * view.w, y: drag.current.vy - ((e.clientY - drag.current.y) / r.height) * view.h });
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; }}
      >
        {app.airspaces.map((a) =>
          a.polygons.map((poly, i) => (
            <polygon key={`${a.id}${i}`} className={`airspace ${a.id === unit.id ? 'own' : 'other'}`} points={poly.map((p) => `${X(p.lon)},${Y(p.lat)}`).join(' ')} />
          )),
        )}
        {app.map.airways.map((a, i) =>
          inView(a.points[0][0], a.points[0][1]) ? (
            <line key={i} className="awy" x1={X(a.points[0][1])} y1={Y(a.points[0][0])} x2={X(a.points[1][1])} y2={Y(a.points[1][0])} />
          ) : null,
        )}
        {app.map.fixes.filter((f) => inView(f.lat, f.lon)).map((f) => (
          <g key={f.name} className="fixsym" transform={`translate(${X(f.lon)},${Y(f.lat)})`}>
            <polygon points={`0,${-s * 0.8} ${s * 0.7},${s * 0.5} ${-s * 0.7},${s * 0.5}`} />
            {view.w < W * 0.7 && <text x={s} y={s * 1.6} fontSize={s * 1.5}>{f.name}</text>}
          </g>
        ))}
        {conflictPairs.map((c) => (
          <circle key={c.id} className={`conf-loc sev-${c.severity.toLowerCase()}`} cx={X(c.location.lon)} cy={Y(c.location.lat)} r={s * 4} />
        ))}
        {flights.map((f) => {
          if (selected !== f.callsign) return null;
          const pts = f.route.filter((p) => inView(p.lat, p.lon));
          return <polyline key={`r-${f.callsign}`} className="sel-route" points={pts.map((p) => `${X(p.lon)},${Y(p.lat)}`).join(' ')} />;
        })}
        {flights.map(symbol)}
      </svg>
    </div>
  );
}
