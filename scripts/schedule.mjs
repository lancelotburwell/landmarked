// Plans the daily puzzles: which five buildings, and which of their clues, each date.
//
//   npm run schedule                 replan everything after the frozen week, up to BUFFER_DAYS ahead
//   npm run schedule -- --days 42    plan further ahead
//   npm run schedule -- --keep       keep already planned days (e.g. hand edits), only append
//   npm run schedule -- --from 2026-11-25   replan from that date (must be after today), even inside
//                                    the frozen week; days with an Instagram post keep that building
//
// data/schedule.json is the record of what ran when: one line per date,
// { date, ids, clues } where clues[i] is the index into that building's clue list.
// The next FROZEN_DAYS days are never changed: players never see a puzzle swap
// under them (some time zones are already a day ahead), and the weekly
// Instagram sneak peeks (data/social.json) are made a week ahead from them.
//
// Rules per day: 2 easy, 2 medium, 1 hard; never-used buildings first, so a
// building only comes back once its tier has no fresh ones left; then least
// recently used, not within MIN_GAP_DAYS of its last use; at least
// MIN_SPREAD_KM from the day's other buildings. Rules relax, with a warning,
// only when the pool is too small. A building that comes back gets its next
// unused clue; if it has none, the report lists it so a new clue gets written
// (add it under the same id in data/clues/, then build-buildings appends it and
// the next nightly run picks it up for any day outside the frozen week).
// A replanned day that already has an Instagram post (data/social.json) keeps
// that building.
import { readFileSync, writeFileSync } from 'node:fs';

const DAY_TIERS = ['easy', 'easy', 'medium', 'medium', 'hard']; // 2/1/2 until 2026-11-23
const BUFFER_DAYS = 28;
const FROZEN_DAYS = 8; // today + 8: covers next week's sneak peeks, made the day before the week starts
const MIN_GAP_DAYS = 180; // a repeat should not feel like one
const MIN_SPREAD_KM = 1500;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] ?? true; };
const buffer = Number(opt('--days') ?? BUFFER_DAYS);
const keep = Boolean(opt('--keep'));
const from = opt('--from');

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const pool = read('data/buildings.json');
const byId = new Map(pool.map((b) => [b.id, b]));
const schedule = read('data/schedule.json');
const social = new Map(read('data/social.json').map((s) => [s.date, s.id]));

// ---------- dates (local calendar days, like the game) ----------
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return key(new Date(y, m - 1, d + n)); };
const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };
const today = key(new Date());
const frozenUntil = addDays(today, FROZEN_DAYS);
const planUntil = addDays(today, buffer);
if (from !== undefined && !(typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) && from > today)) throw new Error('--from needs a date after today (YYYY-MM-DD)');

// ---------- helpers ----------
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function distanceKm(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- keep the past ----------
const kept = schedule.filter((d) => (from ? d.date < from : d.date <= frozenUntil) || keep).sort((a, b) => a.date.localeCompare(b.date));
for (const d of kept) for (const id of d.ids) if (!byId.has(id)) throw new Error(`${d.date}: unknown building "${id}" (never delete scheduled buildings; retire them instead)`);
const lastUsed = new Map();
const uses = new Map();
for (const d of kept) d.ids.forEach((id, i) => { lastUsed.set(id, dayNum(d.date)); uses.set(id, [...(uses.get(id) ?? []), d.clues?.[i] ?? 0]); }); // clue indexes shown so far

// ---------- plan the future ----------
const warnings = [];
const needClue = [];
let gapBreaks = 0;
const planned = [];
let firstRepeat = null;
// Continue after the last kept day; if the schedule lapsed, start today (lapsed days used the fallback).
let date = kept.length ? addDays(kept[kept.length - 1].date, 1) : today;
if (date < today) date = today;
for (; date <= planUntil; date = addDays(date, 1)) {
  const n = dayNum(date);
  const day = [];
  const rested = (c) => n - c.last >= MIN_GAP_DAYS;
  const apart = (c) => day.every((o) => distanceKm(o, c.b) >= MIN_SPREAD_KM);
  const bestFor = (tier) => {
    // Oldest use first; ties (e.g. never used) in a stable per-date shuffle.
    const cands = pool
      .filter((b) => b.tier === tier && !b.retired && !day.includes(b))
      .map((b) => ({ b, last: lastUsed.get(b.id) ?? -Infinity, tie: hash(`${date}:${b.id}`) }))
      .sort((x, y) => x.last - y.last || x.tie - y.tie);
    if (!cands.length) throw new Error(`no ${tier} buildings left`);
    // A fresh building beats spread (user's rule: no repeats while fresh ones are left);
    // among repeats, spread matters more to players than the gap, so the gap gives way first.
    const fresh = (c) => c.last === -Infinity;
    return cands.find((c) => fresh(c) && apart(c)) ?? cands.find(fresh) ?? cands.find((c) => rested(c) && apart(c)) ?? cands.find(apart) ?? cands[0];
  };
  const slots = [...DAY_TIERS];
  // An Instagram post already promises this building for the day.
  const pinned = byId.get(social.get(date));
  if (pinned) {
    if ((lastUsed.get(pinned.id) ?? -Infinity) !== -Infinity) firstRepeat ??= date;
    day.push(pinned);
    lastUsed.set(pinned.id, n);
    slots.splice(slots.indexOf(pinned.tier), 1);
  }
  // Fill the most overdue slot first, so no building is always crowded out by others' spread.
  while (slots.length) {
    const best = slots.map((tier) => ({ tier, c: bestFor(tier) })).reduce((a, x) => (x.c.last < a.c.last || (x.c.last === a.c.last && x.c.tie < a.c.tie) ? x : a));
    const pick = best.c;
    slots.splice(slots.indexOf(best.tier), 1);
    if (!rested(pick)) gapBreaks++;
    if (!apart(pick)) warnings.push(`${date} ${best.tier}: ${pick.b.id} is closer than ${MIN_SPREAD_KM} km to another of the day`);
    if (pick.last !== -Infinity) firstRepeat ??= date;
    day.push(pick.b);
    lastUsed.set(pick.b.id, n);
  }
  // Rounds always run easy → hard.
  day.sort((a, b) => DAY_TIERS.indexOf(a.tier) - DAY_TIERS.indexOf(b.tier));
  const clues = day.map((b) => {
    // The first clue this building has never shown; if all have been shown, the least used one.
    const shown = uses.get(b.id) ?? [];
    let i = b.clues.findIndex((_, k) => !shown.includes(k));
    if (i < 0) {
      needClue.push(`${date} ${b.id}`);
      const count = (k) => shown.filter((s) => s === k).length;
      i = b.clues.reduce((best, _, k) => (count(k) < count(best) ? k : best), 0);
    }
    uses.set(b.id, [...shown, i]);
    return i;
  });
  planned.push({ date, ids: day.map((b) => b.id), clues });
}

const all = [...kept, ...planned];
writeFileSync(new URL('data/schedule.json', root), '[\n' + all.map((d) => '  ' + JSON.stringify(d)).join(',\n') + '\n]\n');

// ---------- report ----------
const live = pool.filter((b) => !b.retired);
const used = new Set(all.flatMap((d) => d.ids));
const fresh = live.filter((b) => !used.has(b.id));
const freshBy = Object.fromEntries(DAY_TIERS.filter((t, i, a) => a.indexOf(t) === i).map((t) => [t, fresh.filter((b) => b.tier === t).length]));
console.log(`schedule: ${all.length} days, ${kept.length} kept (frozen through ${frozenUntil}${keep ? ', --keep' : ''}), ${planned.length} planned, last day ${all[all.length - 1]?.date}`);
console.log(`pool: ${live.length} buildings; never used after this plan: ${fresh.length}`, freshBy);
if (firstRepeat) console.log(`first building reused on ${firstRepeat} (add buildings to push this back)`);
if (needClue.length) {
  console.log(`${needClue.length} repeats have no unused clue yet; write a new clue for each (same id in data/clues/):`);
  for (const w of needClue) console.log('  ' + w);
}
if (gapBreaks) console.log(`${gapBreaks} picks came back sooner than ${MIN_GAP_DAYS} days: the pool is too small for that gap yet`);
if (warnings.length) {
  console.log(`${warnings.length} picks could not be kept ${MIN_SPREAD_KM} km apart:`);
  for (const w of warnings.slice(0, 8)) console.log('  ' + w);
  if (warnings.length > 8) console.log(`  … and ${warnings.length - 8} more`);
}
