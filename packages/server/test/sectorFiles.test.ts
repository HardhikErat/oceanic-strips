import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverSectorFiles, eseHomeFir, loadSectorFiles } from '../src/nav/sectorFiles.ts';

// Synthetic sector files (no AeroNav data): a square oceanic sector owned by the oceanic
// position, plus NavData with one airway.
const MID = '·';
function ese(fir: string, airac: string, opts: { publisher?: boolean; ownerId?: string } = {}) {
  const id = opts.ownerId ?? 'BOC';
  return [
    `;  AIRAC ${airac}/1${opts.publisher === false ? '' : `  ++  File-Publisher: Test - ${fir}`}`,
    '[POSITIONS]',
    `${fir}_OC_CTR:Test Radio:132.600:${id}:OC:${fir}:CTR:::0000:0000`,
    'XXXX_CTR:Other Control:120.000:XX::XXXX:CTR:::0000:0000',
    '[AIRSPACE]',
    'SECTORLINE:1',
    'COORD:N010.00.00.000:E060.00.00.000',
    'COORD:N020.00.00.000:E060.00.00.000',
    'COORD:N020.00.00.000:E070.00.00.000',
    'COORD:N010.00.00.000:E070.00.00.000',
    'COORD:N010.00.00.000:E060.00.00.000',
    `SECTOR:${fir}${MID}OCEANIC${MID}000${MID}460:00000:46000`,
    `OWNER:${id}`,
    'BORDER:1',
    `SECTOR:${fir}${MID}OTHER${MID}000${MID}100:00000:10000`,
    'OWNER:XX',
    'BORDER:1',
    `SECTOR:XXXX${MID}NEIGHBOUR${MID}000${MID}100:00000:10000`,
    'OWNER:XX',
    'BORDER:1',
    '',
  ].join('\n');
}

function install(root: string, rel: string, fir: string, airac: string, opts?: { publisher?: boolean; ownerId?: string }) {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, 'data', 'NavData'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'my sector.ese'), ese(fir, airac, opts), 'latin1');
  fs.writeFileSync(path.join(dir, 'my sector.sct'), '[FIXES]\nTESTA N015.00.00.000 E065.00.00.000\n', 'latin1');
  fs.writeFileSync(path.join(dir, 'data', 'NavData', 'airway.txt'), 'TESTA\t15.0\t65.0\t14\tW1\tB\t\t\t\t\tN\tTESTB\t16.0\t66.0\t\tY\n');
  fs.writeFileSync(path.join(dir, 'data', 'NavData', 'isec.txt'), 'TESTA\t15.0\t65.0\t15\nTESTB\t16.0\t66.0\t15\n');
  fs.writeFileSync(path.join(dir, 'data', 'NavData', 'icao.txt'), 'XXXX\t15.5\t65.5\tTEST\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strips-sectors-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('sector files are found by content, not by name', () => {
  // odd names and the double folder an unzip often creates
  install(tmp, 'downloads/mumbai stuff/inner', 'VABF', '2610');
  install(tmp, 'new airac/whatever', 'VABF', '2611');
  install(tmp, 'chennai', 'VOMF', '2611', { publisher: false, ownerId: 'COC' });

  it('identifies the FIR from the publisher line or the sector prefixes', () => {
    expect(eseHomeFir(ese('VABF', '2611'))).toBe('VABF');
    expect(eseHomeFir(ese('VOMF', '2611', { publisher: false }))).toBe('VOMF');
  });

  it('finds files anywhere below the folder and keeps the newest AIRAC per FIR', () => {
    const { byFir, all } = discoverSectorFiles([tmp]);
    expect(all).toHaveLength(3);
    expect(byFir.VABF.airac).toBe('2611');
    expect(byFir.VABF.ese).toContain('new airac');
    expect(byFir.VABF.sct).toBeDefined();
    expect(byFir.VABF.navDir).toContain('NavData');
    expect(byFir.VOMF.airac).toBe('2611');
  });

  it('builds unit airspaces and reports a missing FIR as a set-up problem', () => {
    const idx = loadSectorFiles(
      [tmp],
      [
        { id: 'VABX', sectorFile: 'VABF', ownerId: 'BOC', esPositions: ['VABF_OC_CTR'] },
        { id: 'VOMX', sectorFile: 'VOMF', ownerId: 'WRONG', esPositions: ['VOMF_OC_CTR'] },
        { id: 'VECX', sectorFile: 'VECF', ownerId: 'KOX', esPositions: ['VECF_OC_CTR'] },
      ],
      path.join(tmp, 'cache.json'),
    );
    expect(idx.airspaces.find((a) => a.id === 'VABX')!.polygons).toHaveLength(1);
    expect(idx.airspaces.find((a) => a.id === 'VOMX')!.polygons).toHaveLength(1); // owner found via callsign
    expect(idx.airspaces.find((a) => a.id === 'VECX')!.polygons).toHaveLength(0);
    expect(idx.problems.some((p) => p.startsWith('VECX: no VECF sector file'))).toBe(true);
    expect(idx.airac).toBe('2611');
    expect(idx.nav.airways.W1?.TESTA).toBeDefined();
  });
});
