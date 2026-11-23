// Adds newly written buildings to the pool (data/buildings.json).
//
//   node scripts/build-buildings.mjs
//
// Inputs:
//   data/selection.json   ranked candidates (select-buildings.mjs)
//   data/clues/*.json     { "<id>": { name, architect, year, city, country, clue | clues, blurb, tier? } }
//                         or { "<id>": { "drop": "reason" } } to leave one out.
//   data/buildings.json   the pool itself.
//
// The pool only grows: existing buildings keep their fields and tier, because
// past days in data/schedule.json point at them. A clue file entry for an
// existing id updates its text fields, and extra clues are appended (used when
// the building comes back). A "drop" on an existing id marks it retired, so it
// is never scheduled again. New buildings get a tier from their fame rank in
// the whole selection: top 40% easy, next 40% medium, rest hard (the daily 2/2/1).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const sel = read('data/selection.json').items;
const pool = read('data/buildings.json');
const byId = new Map(pool.map((b) => [b.id, b]));
const rank = new Map(sel.map((s, i) => [s.id, i]));
const tierFor = (id) => {
  const r = (rank.get(id) ?? sel.length) / sel.length;
  return r < 0.4 ? 'easy' : r < 0.8 ? 'medium' : 'hard';
};

const clues = {};
for (const f of readdirSync(new URL('data/clues/', root)).filter((f) => f.endsWith('.json')).sort()) {
  Object.assign(clues, read(`data/clues/${f}`));
}
const listOf = (c) => (c.clues ?? (c.clue ? [c.clue] : [])).filter(Boolean);

let added = 0, updated = 0, retired = 0;
// Existing buildings: retire, or update text and append new clues.
for (const b of pool) {
  const c = clues[b.id];
  if (!c) continue;
  if (c.drop) {
    if (!b.retired) { b.retired = c.drop; retired++; }
    continue;
  }
  for (const k of ['name', 'architect', 'city', 'country', 'blurb']) if (c[k]) b[k] = c[k];
  if (c.year) b.year = String(c.year);
  const extra = listOf(c).filter((t) => !b.clues.includes(t));
  if (extra.length) { b.clues.push(...extra); updated++; }
}
// New buildings: any selection entry with a written clue.
const missing = [];
for (const s of sel) {
  const c = clues[s.id];
  if (byId.has(s.id) || c?.drop) continue;
  if (!c || !listOf(c).length) { missing.push(s.id); continue; }
  const b = {
    id: s.id,
    name: c.name ?? s.name,
    architect: c.architect ?? (s.architects ?? []).join(', '),
    year: String(c.year ?? s.year ?? ''),
    city: c.city,
    country: c.country ?? s.country,
    tier: c.tier ?? tierFor(s.id),
    wiki: s.wiki,
    lon: s.lon,
    lat: s.lat,
    clues: listOf(c),
    blurb: c.blurb,
    qid: s.qid,
  };
  pool.push(b);
  byId.set(b.id, b);
  added++;
}

const problems = [];
const COMMON = ['tower', 'towers','house', 'palace', 'castle', 'church', 'cathedral', 'temple', 'mosque', 'museum', 'building', 'centre', 'center', 'basilica', 'national', 'great', 'royal', 'saint', 'grand', 'opera', 'theatre', 'library', 'station', 'hotel', 'stadium', 'hall'];
for (const b of pool) {
  if (b.retired) continue;
  for (const k of ['name', 'architect', 'year', 'city', 'country', 'blurb']) if (!b[k]) problems.push(`${b.id}: missing ${k}`);
  if (!b.clues?.length) problems.push(`${b.id}: no clue`);
  // A clue must not give the name away.
  const words = b.name.toLowerCase().replace(/\(.*?\)/g, '').split(/[^a-zà-ÿ0-9]+/).filter((w) => w.length > 4 && !COMMON.includes(w));
  for (const clue of b.clues ?? []) for (const w of words) if (clue.toLowerCase().includes(w)) problems.push(`${b.id}: clue contains "${w}"`);
}

writeFileSync(new URL('data/buildings.json', root), '[\n' + pool.map((b) => '  ' + JSON.stringify(b)).join(',\n') + '\n]\n');
const live = pool.filter((b) => !b.retired);
const tally = live.reduce((m, b) => ((m[b.tier] = (m[b.tier] ?? 0) + 1), m), {});
console.log(`pool: ${live.length} buildings`, tally, `(+${added} new, ${updated} with new clues, ${retired} retired)`);
if (missing.length) console.log(`${missing.length} in the selection still need clues, next up: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' …' : ''}`);
if (problems.length) console.log(`problems:\n  ${problems.join('\n  ')}`);
console.log('Next: node scripts/fetch-photos.mjs, then npm run schedule.');
