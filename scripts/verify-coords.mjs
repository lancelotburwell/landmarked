// Cross-checks every building's lon/lat against Wikipedia (article coordinates)
// and Wikidata (P625). Prints the distance to each; `--write` adopts Wikipedia's.
// Usage: node scripts/verify-coords.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../src/data/buildings.json', import.meta.url);
const UA = { 'User-Agent': 'landmarked-coord-check/1.0 (static game data check)' };
const buildings = JSON.parse(readFileSync(FILE, 'utf8'));

function km(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function wiki(titles) {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', prop: 'coordinates|pageprops', colimit: 'max', ppprop: 'wikibase_item', titles: titles.join('|'), redirects: '1', format: 'json', formatversion: '2' });
  const j = await (await fetch(u, { headers: UA })).json();
  const norm = new Map();
  for (const n of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) norm.set(n.from, n.to);
  const out = new Map();
  for (const t of titles) {
    let k = t; while (norm.has(k)) k = norm.get(k);
    const p = j.query.pages.find((x) => x.title === k);
    out.set(t, { coord: p?.coordinates?.[0], qid: p?.pageprops?.wikibase_item });
  }
  return out;
}

async function wikidata(qids) {
  const u = new URL('https://www.wikidata.org/w/api.php');
  u.search = new URLSearchParams({ action: 'wbgetentities', ids: qids.join('|'), props: 'claims', format: 'json' });
  const j = await (await fetch(u, { headers: UA })).json();
  const out = new Map();
  for (const q of qids) {
    const v = j.entities?.[q]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if (v) out.set(q, { lat: v.latitude, lon: v.longitude });
  }
  return out;
}

const write = process.argv.includes('--write');
let bad = 0;
for (let i = 0; i < buildings.length; i += 40) {
  const chunk = buildings.slice(i, i + 40);
  const w = await wiki(chunk.map((b) => b.wiki));
  const wd = await wikidata([...new Set([...w.values()].map((x) => x.qid).filter(Boolean))]);
  for (const b of chunk) {
    const { coord, qid } = w.get(b.wiki) ?? {};
    const d = qid && wd.get(qid);
    const dW = coord ? km(b, coord) : NaN;
    const dD = d ? km(b, d) : NaN;
    const agree = coord && d ? km(coord, d) : NaN;
    const ref = coord ?? d; const flag = !ref || agree > 1 ? '  <-- CHECK' : '';
    if (flag) bad++;
    console.log(`${b.id.padEnd(24)} wiki ${isNaN(dW) ? '  n/a' : dW.toFixed(2).padStart(6)} km  wikidata ${isNaN(dD) ? '  n/a' : dD.toFixed(2).padStart(6)} km  (wiki↔wd ${isNaN(agree) ? 'n/a' : agree.toFixed(2)} km)${flag}`);
    if (write && ref) { b.lat = +ref.lat.toFixed(5); b.lon = +ref.lon.toFixed(5); }
  }
}
console.log(`\n${buildings.length} buildings, ${bad} to check`);
if (write) {
  const lines = buildings.map((b) => '  ' + JSON.stringify(b));
  writeFileSync(FILE, '[\n' + lines.join(',\n') + '\n]\n');
  console.log('Wrote Wikipedia coordinates to src/data/buildings.json');
}
