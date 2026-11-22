// Plans the daily puzzles: which five buildings, and which of their clues, each date.
//
//   npm run schedule                 replan everything after the frozen week, up to BUFFER_DAYS ahead
//   npm run schedule -- --days 42    plan further ahead
//   npm run schedule -- --keep       keep already planned days (e.g. hand edits), only append
//
// data/schedule.json is the record of what ran when: one line per date,
// { date, ids, clues } where clues[i] is the index into that building's clue list.
// The next FROZEN_DAYS days are never changed: players never see a puzzle swap
// under them (some time zones are already a day ahead), and the weekly
// Instagram sneak peeks (data/social.json) are made a week ahead from them.
//
// Rules per day: 2 easy, 1 medium, 2 hard; least recently used first (never
// used counts as oldest); not within MIN_GAP_DAYS of its last use; at least
// MIN_SPREAD_KM from the day's other buildings. Rules relax, with a warning,
// only when the pool is too small. A building that comes back gets its next clue.
import { readFileSync, writeFileSync } from 'node:fs';

const DAY_TIERS = ['easy', 'easy', 'medium', 'hard', 'hard'];
const BUFFER_DAYS = 28;
const FROZEN_DAYS = 8; // today + 8: covers next week's sneak peeks, made the day before the week starts
const MIN_GAP_DAYS = 45;
const MIN_SPREAD_KM = 1500;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] ?? true; };
const buffer = Number(opt('--days') ?? BUFFER_DAYS);
const keep = Boolean(opt('--keep'));

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const pool = read('data/buildings.json');
const byId = new Map(pool.map((b) => [b.id, b]));
const schedule = read('data/schedule.json');

// ---------- dates (local calendar days, like the game) ----------
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return key(new Date(y, m - 1, d + n)); };
const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };
const today = key(new Date());
const frozenUntil = addDays(today, FROZEN_DAYS);
const planUntil = addDays(today, buffer);

// ---------- helpers ----------
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function distanceKm(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- keep the past ----------
const kept = schedule.filter((d) => d.date <= frozenUntil || keep).sort((a, b) => a.date.localeCompare(b.date));
for (const d of kept) for (const id of d.ids) if (!byId.has(id)) throw new Error(`${d.date}: unknown building "${id}" (never delete scheduled buildings; retire them instead)`);
const lastUsed = new Map();
const uses = new Map();
for (const d of kept) for (const id of d.ids) { lastUsed.set(id, dayNum(d.date)); uses.set(id, (uses.get(id) ?? 0) + 1); }

// ---------- plan the future ----------
const warnings = [];
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
    // Spread matters more to players than the gap, so the gap gives way first.
    return cands.find((c) => rested(c) && apart(c)) ?? cands.find(apart) ?? cands[0];
  };
  // Fill the most overdue slot first, so no building is always crowded out by others' spread.
  const slots = [...DAY_TIERS];
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
  const clues = day.map((b) => { const u = uses.get(b.id) ?? 0; uses.set(b.id, u + 1); return u % b.clues.length; });
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
if (gapBreaks) console.log(`${gapBreaks} picks came back sooner than ${MIN_GAP_DAYS} days: the pool is too small for that gap yet`);
if (warnings.length) {
  console.log(`${warnings.length} picks could not be kept ${MIN_SPREAD_KM} km apart:`);
  for (const w of warnings.slice(0, 8)) console.log('  ' + w);
  if (warnings.length > 8) console.log(`  … and ${warnings.length - 8} more`);
}
