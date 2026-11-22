// Downloads one photo per building from Wikimedia Commons (the building's
// Wikidata "image", P18), keeps only licences that allow commercial use with
// credit, and stores a resized copy with the site.
//
//   node scripts/fetch-photos.mjs [--force]
//     → public/photos/<id>.jpg  (640 px wide, JPEG)
//     → public/photos/credits.json  { id: { w, h, artist, license, licenseUrl, page } }
//
// Also fills in the Wikidata id (qid) of buildings that lack one.
// Resizing uses Python + Pillow (scripts/resize-photo.py).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };
const root = new URL('../', import.meta.url);
const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OK_LICENSE = /^(cc0|public domain|pd\b|pd-|cc by(-sa)? [1-4]\.0|cc by(-sa)? 2\.5|cc-by(-sa)?-[1-4]\.0)/i;

async function api(base, params) {
  const u = new URL(base);
  u.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(u, { headers: UA });
      const t = await r.text();
      if (r.ok && t.startsWith('{')) return JSON.parse(t);
    } catch { /* retry */ }
    await sleep(3000 * (a + 1));
  }
  throw new Error(`failed: ${u}`);
}
const strip = (html = '') => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

const bFile = new URL('data/buildings.json', root);
const buildings = JSON.parse(readFileSync(bFile, 'utf8'));
const pFile = new URL('public/photos/credits.json', root);
const photos = existsSync(pFile) ? JSON.parse(readFileSync(pFile, 'utf8')) : {};
const rawDir = new URL('data/.cache/photos-raw/', root);
const outDir = new URL('public/photos/', root);
mkdirSync(rawDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1. qids for buildings that lack one (via the English Wikipedia article)
const noQid = buildings.filter((b) => !b.qid);
for (let i = 0; i < noQid.length; i += 40) {
  const chunk = noQid.slice(i, i + 40);
  const j = await api('https://en.wikipedia.org/w/api.php', { action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', titles: chunk.map((b) => b.wiki).join('|') });
  const map = new Map();
  for (const r of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) map.set(r.from, r.to);
  for (const b of chunk) {
    let t = b.wiki;
    while (map.has(t)) t = map.get(t);
    const p = j.query.pages.find((x) => x.title === t);
    if (p?.pageprops?.wikibase_item) b.qid = p.pageprops.wikibase_item;
  }
}

// 2. image file names from Wikidata
const todo = buildings.filter((b) => b.qid && (force || !photos[b.id]));
const fileOf = {};
for (let i = 0; i < todo.length; i += 40) {
  const j = await api('https://www.wikidata.org/w/api.php', { action: 'wbgetentities', ids: todo.slice(i, i + 40).map((b) => b.qid).join('|'), props: 'claims' });
  for (const b of todo.slice(i, i + 40)) {
    const claims = j.entities[b.qid]?.claims?.P18 ?? [];
    const best = claims.find((c) => c.rank === 'preferred') ?? claims.find((c) => c.rank === 'normal');
    if (best) fileOf[b.id] = best.mainsnak.datavalue.value;
  }
}

// 3. licence + thumbnail from Commons, then download and resize
let ok = 0;
const skipped = [];
for (const b of todo) {
  try {
  const file = fileOf[b.id];
  if (!file) { skipped.push(`${b.id}: no image on Wikidata`); continue; }
  const j = await api('https://commons.wikimedia.org/w/api.php', { action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '960' });
  const info = j.query.pages[0]?.imageinfo?.[0];
  const m = info?.extmetadata ?? {};
  const license = strip(m.LicenseShortName?.value);
  if (!info || !OK_LICENSE.test(license)) { skipped.push(`${b.id}: licence "${license || 'unknown'}"`); continue; }
  const raw = new URL(`${b.id}`, rawDir);
  const res = await fetch(info.thumburl ?? info.url, { headers: UA });
  if (!res.ok) { skipped.push(`${b.id}: download ${res.status}`); continue; }
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  const out = new URL(`${b.id}.jpg`, outDir);
  const py = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-I', new URL('scripts/resize-photo.py', root).pathname.replace(/^\/([A-Z]:)/, '$1'), raw.pathname.replace(/^\/([A-Z]:)/, '$1'), out.pathname.replace(/^\/([A-Z]:)/, '$1')], { encoding: 'utf8' });
  if (py.status !== 0) { skipped.push(`${b.id}: resize failed ${py.stderr.slice(0, 120)}`); continue; }
  const [w, h] = py.stdout.trim().split('x').map(Number);
  photos[b.id] = {
    w, h,
    artist: strip(m.Artist?.value).slice(0, 120) || 'Unknown',
    license,
    licenseUrl: m.LicenseUrl?.value ?? null,
    page: info.descriptionurl,
  };
  ok++;
  writeFileSync(pFile, JSON.stringify(photos, null, 1) + '\n'); // save as we go
  } catch (e) {
    skipped.push(`${b.id}: ${String(e).slice(0, 80)} (rerun to retry)`);
  }
  await sleep(1500);
}

writeFileSync(bFile, '[\n' + buildings.map((b) => '  ' + JSON.stringify(b)).join(',\n') + '\n]\n');
writeFileSync(pFile, JSON.stringify(photos, null, 1) + '\n');
console.log(`photos: ${ok} new, ${Object.keys(photos).length} total of ${buildings.length}`);
if (skipped.length) console.log('skipped:\n  ' + skipped.join('\n  '));
