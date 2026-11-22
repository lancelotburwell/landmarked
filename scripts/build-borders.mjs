// Builds public/borders.json from Natural Earth 1:50m (public domain).
//   lines:  [[lon,lat,lon,lat,...], ...]   land boundary lines (no coastlines)
//   labels: [[ "FR", lon, lat, minZoomRank ], ...]
// Usage: node scripts/build-borders.mjs <dir with ne_50m_admin_0_boundary_lines_land.geojson + ne_50m_admin_0_countries.geojson>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const lines = JSON.parse(readFileSync(join(dir, 'ne_50m_admin_0_boundary_lines_land.geojson'), 'utf8'));
const countries = JSON.parse(readFileSync(join(dir, 'ne_50m_admin_0_countries.geojson'), 'utf8'));

const q = (v) => Math.round(v * 100) / 100; // ~1 km, plenty for a thin overlay
const outLines = [];
for (const f of lines.features) {
  const g = f.geometry;
  const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  for (const p of parts) {
    const flat = [];
    let last = '';
    for (const [x, y] of p) {
      const k = q(x) + ',' + q(y);
      if (k === last) continue;
      last = k;
      flat.push(q(x), q(y));
    }
    if (flat.length >= 4) outLines.push(flat);
  }
}

const labels = [];
for (const f of countries.features) {
  const p = f.properties;
  let code = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2;
  if (!code || code === '-99') continue;
  if (p.LABEL_X == null) continue;
  // LABELRANK 1..10: small numbers = big countries, shown from further away
  labels.push([code, q(p.LABEL_X), q(p.LABEL_Y), p.LABELRANK ?? 5]);
}

const out = JSON.stringify({ lines: outLines, labels });
writeFileSync(new URL('../public/borders.json', import.meta.url), out);
console.log(`lines ${outLines.length}, labels ${labels.length}, ${(out.length / 1024).toFixed(0)} KB`);
