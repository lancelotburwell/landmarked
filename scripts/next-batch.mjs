// Gathers the next buildings to write clues for: the most famous entries in
// data/selection.json that aren't in the pool yet, aren't dropped and have no
// clue file entry. For each it fetches the English Wikipedia intro.
//
//   node scripts/next-batch.mjs [count=35]
//     → data/.cache/next-batch.json  [{ id, name, wiki, tier, architects, year, country, locatedIn, classes, lon, lat, intro }]
//     and prints a short summary.
//
// Used by the weekly batch routine (see CLAUDE.md); the clues themselves are
// written by hand into data/clues/NNN-batch-<date>.json.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';

const COUNT = Number(process.argv[2] ?? 35);
const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };
const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sel = read('data/selection.json').items;
const pool = new Set(read('data/buildings.json').map((b) => b.id));
const written = {};
for (const f of readdirSync(new URL('data/clues/', root)).filter((f) => f.endsWith('.json'))) Object.assign(written, read(`data/clues/${f}`));

const todo = sel.filter((s) => !pool.has(s.id) && !written[s.id]);
// Keep each batch in the daily ratio (2 easy, 1 medium, 2 hard), most famous first within each tier.
const share = { easy: 0.37, medium: 0.26, hard: 0.37 };
const picked = [];
for (const tier of ['easy', 'medium', 'hard']) picked.push(...todo.filter((s) => s.tier === tier).slice(0, Math.round(COUNT * share[tier])));
for (const s of todo) if (picked.length < COUNT && !picked.includes(s)) picked.push(s); // top up if a tier ran dry
const batch = picked.slice(0, COUNT).map((s) => ({
  id: s.id, name: s.name, wiki: s.wiki, tier: s.tier, architects: s.architects ?? [], year: s.year ?? null,
  country: s.country, locatedIn: s.locatedIn, classes: s.classes ?? [], lon: s.lon, lat: s.lat, intro: '',
}));

// Wikipedia intros, 20 titles per request.
for (let i = 0; i < batch.length; i += 20) {
  const chunk = batch.slice(i, i + 20);
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exlimit: '20', titles: chunk.map((b) => b.wiki).join('|'), redirects: '1', format: 'json', formatversion: '2' });
  let j = null;
  for (let a = 0; a < 8 && !j; a++) {
    try {
      const t = await (await fetch(u, { headers: UA })).text();
      if (t.startsWith('{')) j = JSON.parse(t);
    } catch { /* retry */ }
    if (!j) await sleep(4000 * (a + 1));
  }
  if (!j) { console.warn('Wikipedia is rate-limiting; intros missing for some buildings (rerun later).'); break; }
  const back = new Map();
  for (const r of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) back.set(r.to, r.from);
  for (const p of j.query.pages) {
    let t = p.title;
    while (back.has(t)) t = back.get(t);
    const b = chunk.find((x) => x.wiki === t);
    if (b) b.intro = (p.extract ?? '').slice(0, 2500);
  }
  await sleep(500);
}

mkdirSync(new URL('data/.cache/', root), { recursive: true });
writeFileSync(new URL('data/.cache/next-batch.json', root), JSON.stringify(batch, null, 1));
const tiers = batch.reduce((m, b) => ((m[b.tier] = (m[b.tier] ?? 0) + 1), m), {});
console.log(`next batch: ${batch.length} of ${todo.length} still without clues`, tiers, '→ data/.cache/next-batch.json');
for (const b of batch) console.log(`  ${b.id.padEnd(40)} ${b.tier.padEnd(6)} ${b.country ?? ''}${b.intro ? '' : '  (no intro)'}`);
