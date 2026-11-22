// Step 2 of the building pipeline: choose the pool from data/candidates.json.
//
//   node scripts/select-buildings.mjs [count=300]   → data/selection.json
//                                                     + data/.cache/extracts.json
//
// - Drops non-buildings (bridges, statues, parks, …) and demolished buildings.
// - Fame score = 35% percentile rank of (number of Wikipedias) + 65% of
//   (English Wikipedia page views over 60 days): views say who's recognised today.
// - Greedy by fame, with spread caps: at most CITY_CAP buildings within
//   CITY_KM of each other, and at most COUNTRY_CAP per country.
// - The current src/data/buildings.json entries are always kept (matched by
//   Wikipedia title), with their hand-written clues.
// - Tiers come from fame rank within the final pool.
// - Fetches the English Wikipedia intro of each new building, as source
//   material for writing clues (cache only, not shipped).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const COUNT = Number(process.argv[2] ?? 300);
const TIER_SHARE = { easy: 0.37, medium: 0.26 }; // rest hard
const CITY_KM = 30;
const CITY_CAP = 4;
const COUNTRY_CAP = Math.round(COUNT * 0.085);
const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };

const EXCLUDE = new RegExp(
  [
    'bridge', 'viaduct', 'dam', 'statue', 'sculpture', 'fountain', 'square', 'plaza', '\\bpark\\b', 'garden', 'street',
    'avenue', 'boulevard', 'canal', 'cemetery', 'archaeological site', '\\bcity\\b', 'neighbou?rhood', 'district',
    'ship', 'railway line', '\\broad\\b', 'highway', 'tunnel', 'island', 'mountain', 'zoo', 'amusement park',
    'theme park', 'landscape', 'lighthouse', 'aqueduct', 'wall\\b', 'quarter', 'campus', 'ruins', 'cave',
    'shipwreck', 'human settlement', 'urban area', 'town', 'village', 'quay', 'harbour', 'port',
    // Sports venues rank high on Wikipedia counts but few people know them as architecture.
    'stadium', 'arena', 'sports venue', 'racecourse', 'velodrome', 'ballpark', 'football',
  ].join('|'),
  'i',
);

const km = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const { items } = JSON.parse(readFileSync(new URL('../data/candidates.json', import.meta.url), 'utf8'));
const existing = JSON.parse(readFileSync(new URL('../src/data/buildings.json', import.meta.url), 'utf8'));
const norm = (t) => t.toLowerCase().replace(/_/g, ' ');

// ---------- filter ----------
const seen = new Set();
const pool = items.filter((x) => {
  if (seen.has(x.qid)) return false;
  seen.add(x.qid);
  if (x.demolished) return false;
  if (x.classLabels.some((c) => c && EXCLUDE.test(c))) return false;
  return true;
});

// ---------- fame ----------
const pct = (arr, key) => {
  const sorted = arr.map((x) => x[key]).sort((a, b) => a - b);
  return (v) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return lo / sorted.length;
  };
};
const pLinks = pct(pool, 'sitelinks');
const pViews = pct(pool, 'views');
for (const x of pool) x.score = +(0.35 * pLinks(x.sitelinks) + 0.65 * pViews(x.views)).toFixed(4);
pool.sort((a, b) => b.score - a.score);

// ---------- choose ----------
const byTitle = new Map(pool.map((x) => [norm(x.enwiki), x]));
const chosen = [];
const keep = [];
for (const b of existing) {
  const x = byTitle.get(norm(b.wiki));
  if (x) chosen.push({ ...x, existing: b });
  else keep.push(b); // not in candidates (e.g. title mismatch): keep as-is
}
const fits = (x) =>
  chosen.filter((c) => km(c, x) < CITY_KM).length < CITY_CAP &&
  chosen.filter((c) => c.country === x.country).length < COUNTRY_CAP;
for (const x of pool) {
  if (chosen.length + keep.length >= COUNT) break;
  if (chosen.some((c) => c.qid === x.qid)) continue;
  if (chosen.some((c) => km(c, x) < 0.3)) continue; // same complex (twin towers, wings, …)
  if (fits(x)) chosen.push(x);
}

// ---------- tiers ----------
chosen.sort((a, b) => b.score - a.score);
const nEasy = Math.round(COUNT * TIER_SHARE.easy);
const nMed = Math.round(COUNT * TIER_SHARE.medium);
const out = chosen.map((x, i) => ({
  id: x.existing?.id ?? slug(x.label),
  qid: x.qid,
  name: x.existing?.name ?? x.label,
  wiki: x.enwiki,
  tier: i < nEasy ? 'easy' : i < nEasy + nMed ? 'medium' : 'hard',
  score: x.score,
  sitelinks: x.sitelinks,
  views: x.views,
  lon: x.lon,
  lat: x.lat,
  architects: x.architectLabels,
  year: x.opened ?? x.inception,
  country: x.countryLabel,
  locatedIn: x.locatedInLabel,
  classes: x.classLabels,
  hasClue: Boolean(x.existing),
}));
// ids must be unique
const ids = new Set();
for (const o of out) {
  let id = o.id, n = 2;
  while (ids.has(id)) id = `${o.id}-${n++}`;
  o.id = id;
  ids.add(id);
}
writeFileSync(new URL('../data/selection.json', import.meta.url), JSON.stringify({ count: out.length, unmatchedExisting: keep.map((b) => b.id), items: out }, null, 1));

const tally = (k) => Object.entries(out.reduce((m, o) => ((m[o[k]] = (m[o[k]] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
console.log(`pool ${pool.length} → chosen ${out.length} (+${keep.length} existing not matched: ${keep.map((b) => b.id).join(', ') || 'none'})`);
console.log('tiers', tally('tier'));
console.log('countries', tally('country').slice(0, 15).map(([c, n]) => `${c} ${n}`).join(', '));
for (const t of ['easy', 'medium', 'hard']) {
  const list = out.filter((o) => o.tier === t);
  console.log(`\n${t.toUpperCase()} (${list.length}) — lowest: ${list.slice(-3).map((o) => `${o.name} [${o.sitelinks} wikis, ${Math.round(o.views / 1000)}k views]`).join('; ')}`);
}

// ---------- Wikipedia intros for clue writing ----------
const cacheDir = new URL('../data/.cache/', import.meta.url);
mkdirSync(cacheDir, { recursive: true });
const cacheFile = new URL('extracts.json', cacheDir);
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const need = out.filter((o) => !o.hasClue && !cache[o.wiki]).map((o) => o.wiki);
for (let i = 0; i < need.length; i += 20) {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exlimit: '20', titles: need.slice(i, i + 20).join('|'), redirects: '1', format: 'json', formatversion: '2' });
  let j = null;
  for (let a = 0; a < 8 && !j; a++) {
    try {
      const t = await (await fetch(u, { headers: UA })).text();
      if (t.startsWith('{')) j = JSON.parse(t);
    } catch { /* retry */ }
    if (!j) await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
  }
  if (!j) { console.warn('extracts: rate-limited, stopping (rerun later)'); break; }
  const back = new Map();
  for (const r of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) back.set(r.to, r.from);
  for (const p of j.query.pages) {
    let t = p.title;
    while (back.has(t)) t = back.get(t);
    cache[t] = (p.extract ?? '').slice(0, 1600);
  }
  await new Promise((r) => setTimeout(r, 300));
}
writeFileSync(cacheFile, JSON.stringify(cache));
console.log(`\nextracts cached: ${Object.keys(cache).length}`);
