// Step 3 of the building pipeline: merge the selection with hand-written clues.
//
//   node scripts/build-buildings.mjs [count=300]   → src/data/buildings.json
//
// Inputs:
//   data/selection.json   chosen candidates, ranked by fame (select-buildings.mjs)
//   data/clues/*.json     { "<id>": { name, architect, year, city, country, clue } }
//                         or { "<id>": { "drop": "reason" } } to leave one out,
//                         optional "tier" to override the fame-based tier.
//   src/data/buildings.json  existing entries keep their clue and fields.
//
// The final pool is the top `count` non-dropped buildings by fame. Tiers are
// recomputed from fame rank within that pool (37% easy, 26% medium, 37% hard).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const COUNT = Number(process.argv[2] ?? 300);
const root = new URL('../', import.meta.url);
const sel = JSON.parse(readFileSync(new URL('data/selection.json', root), 'utf8')).items;
const current = JSON.parse(readFileSync(new URL('src/data/buildings.json', root), 'utf8'));
const byId = new Map(current.map((b) => [b.id, b]));

const clues = {};
for (const f of readdirSync(new URL('data/clues/', root)).filter((f) => f.endsWith('.json')).sort()) {
  Object.assign(clues, JSON.parse(readFileSync(new URL(`data/clues/${f}`, root), 'utf8')));
}

const missing = [];
const rows = [];
for (const s of sel) {
  const c = clues[s.id];
  if (c?.drop) continue;
  const old = byId.get(s.id);
  if (!old && !c?.clue) {
    missing.push(s.id);
    continue;
  }
  const base = old ?? {};
  rows.push({
    s,
    b: {
      id: s.id,
      qid: s.qid,
      name: c?.name ?? base.name ?? s.name,
      architect: c?.architect ?? base.architect,
      year: String(c?.year ?? base.year ?? s.year ?? ''),
      city: c?.city ?? base.city,
      country: c?.country ?? base.country ?? s.country,
      tier: c?.tier,
      wiki: s.wiki,
      // Existing coordinates were verified against Wikipedia; new ones come from Wikidata.
      lon: base.lon ?? s.lon,
      lat: base.lat ?? s.lat,
      clue: c?.clue ?? base.clue,
      blurb: c?.blurb ?? base.blurb,
    },
  });
}

const final = rows.slice(0, COUNT);
const short = COUNT - final.length;
const nEasy = Math.round(final.length * 0.37);
const nMed = Math.round(final.length * 0.26);
final.forEach((r, i) => {
  r.b.tier ??= i < nEasy ? 'easy' : i < nEasy + nMed ? 'medium' : 'hard';
});

const problems = [];
for (const { b } of final) {
  for (const k of ['name', 'architect', 'year', 'city', 'country', 'clue', 'blurb']) if (!b[k]) problems.push(`${b.id}: missing ${k}`);
  // The clue must not give the name away.
  const words = b.name.toLowerCase().replace(/\(.*?\)/g, '').split(/[^a-zà-ÿ0-9]+/).filter((w) => w.length > 4 && !['tower', 'house', 'palace', 'castle', 'church', 'cathedral', 'temple', 'mosque', 'museum', 'building', 'centre', 'center', 'basilica', 'national', 'great', 'royal', 'saint', 'grand', 'opera', 'theatre', 'library', 'station', 'hotel', 'stadium', 'hall'].includes(w));
  for (const w of words) if (b.clue.toLowerCase().includes(w)) problems.push(`${b.id}: clue contains "${w}"`);
}

const out = final.map(({ b }) => b);
const lines = out.map((b) => '  ' + JSON.stringify(b));
writeFileSync(new URL('src/data/buildings.json', root), '[\n' + lines.join(',\n') + '\n]\n');
const tally = out.reduce((m, b) => ((m[b.tier] = (m[b.tier] ?? 0) + 1), m), {});
console.log(`wrote ${out.length} buildings`, tally);
if (short > 0) console.log(`short by ${short}: write clues for more of the selection`);
if (missing.length) console.log(`${missing.length} without clues (skipped): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`);
if (problems.length) console.log(`problems:\n  ${problems.join('\n  ')}`);
