// Parses the locally installed sector files and prints a summary. The cache is written to
// data/local/ (git-ignored). Usage: npm run import-nav
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { loadSectorFiles } from '../nav/sectorFiles.ts';
import { distanceToPolygonEdgeNm } from '@oceanic/core';

const cfg = loadConfig(process.argv.slice(2));
const t0 = Date.now();
const idx = loadSectorFiles(cfg.sectorRoots, cfg.units.map((u) => ({ id: u.id, sectorFile: u.sectorFile, ownerId: u.ownerId, esPositions: u.esPositions })), path.join(cfg.dataDir, 'nav-cache.json'));
console.log(`AIRAC ${idx.airac}  parsed in ${Date.now() - t0} ms`);
console.log(`fixes ${Object.keys(idx.nav.fixes).length}  airways ${Object.keys(idx.nav.airways).length}  airports ${Object.keys(idx.nav.airports).length}  sectors ${idx.sectors.length}`);
for (const a of idx.airspaces) {
  console.log(`${a.id}: ${a.polygons.length} polygons, ${a.polygons.map((p) => p.length).join('/')} vertices`);
}
if (process.argv.includes('--boundary')) {
  const unit = process.argv[process.argv.indexOf('--boundary') + 1];
  const a = idx.airspaces.find((x) => x.id === unit)!;
  const names = new Set<string>();
  for (const g of Object.values(idx.nav.airways)) for (const [n, node] of Object.entries(g)) {
    if (a.polygons.some((p) => distanceToPolygonEdgeNm(node, p) < 2)) names.add(`${n} ${node.lat.toFixed(2)} ${node.lon.toFixed(2)}`);
  }
  console.log([...names].sort().join('\n'));
}
