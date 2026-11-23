// Plans the daily puzzles: which five buildings, and which of their clues, each date.
//
//   npm run schedule                 replan everything after the locked days, up to BUFFER_DAYS ahead
//   npm run schedule -- --days 42    plan further ahead
//   npm run schedule -- --keep       keep already planned days (e.g. hand edits), only append
//   npm run schedule -- --from 2026-11-25   replan every day from that date (after today), even
//                                    locked ones; pins and Instagram posts are still respected
//
// data/schedule.json is the record of what ran when: one line per date,
// { date, ids, clues } where clues[i] is the index into that building's clue list.
//
// Three windows (see CLAUDE.md): the next FROZEN_DAYS days are locked, so players
// never see a puzzle swap under them and the Instagram drafts stay valid; the plan
// reaches BUFFER_DAYS ahead and is redrawn every night; and STOCK_DAYS of buildings
// that were never used should be in hand beyond the locked days (check-plan.mjs).
//
// Manual changes go in data/pins.json (see lib/plan.mjs). A pinned building always
// runs on its date, also on a locked day: there it replaces a building of the same
// tier and leaves the rest of the day alone. A building pinned to a future date is
// kept out of the days before it. `notBefore` keeps a building out until a date.
// Days that already have an Instagram post (data/social.json) keep that building.
//
// Rules per day: 2 easy, 2 medium, 1 hard; never-used buildings first, so a
// building only comes back once its tier has no fresh ones left; then least
// recently used, not within MIN_GAP_DAYS of its last use; at least
// MIN_SPREAD_KM from the day's other buildings. Rules relax, with a warning,
// only when the pool is too small. A building that comes back gets a clue it
// has not shown before; if it has none, the report lists it so a new clue gets
// written (same id in data/clues/; build-buildings appends it).
import { writeFileSync } from 'node:fs';
import {
  DAY_TIERS, BUFFER_DAYS, FROZEN_DAYS, MIN_GAP_DAYS, MIN_SPREAD_KM,
  root, read, addDays, dayNum, today as todayKey, isDate, distanceKm, readPins,
} from './lib/plan.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] ?? true; };
const buffer = Number(opt('--days') ?? BUFFER_DAYS);
const keep = Boolean(opt('--keep'));
const from = opt('--from');

const pool = read('data/buildings.json');
const byId = new Map(pool.map((b) => [b.id, b]));
const schedule = read('data/schedule.json');
const { dayPins, dayOut, notBefore, problems } = readPins(pool);

const today = todayKey();
const frozenUntil = addDays(today, FROZEN_DAYS);
const planUntil = addDays(today, buffer);
if (from !== undefined && !(isDate(from) && from > today)) throw new Error('--from needs a date after today (YYYY-MM-DD)');

const hash = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const report = [];

// ---------- keep the past and the locked days ----------
const kept = schedule.filter((d) => (from ? d.date < from : d.date <= frozenUntil) || keep).sort((a, b) => a.date.localeCompare(b.date));
for (const d of kept) for (const id of d.ids) if (!byId.has(id)) throw new Error(`${d.date}: unknown building "${id}" (never delete scheduled buildings; retire them instead)`);

// A pin on a locked day (after today) is applied by swapping just that building in.
for (const d of kept) {
  const want = dayPins.get(d.date);
  if (!want || d.date <= today) continue;
  const protectedIds = new Set(want);
  const out = dayOut.get(d.date) ?? new Set();
  for (const id of want) {
    if (d.ids.includes(id)) continue;
    const tier = byId.get(id).tier;
    const swappable = (i) => !protectedIds.has(d.ids[i]);
    // The building it was meant to replace first, then one of the same tier, then any.
    let i = d.ids.findIndex((x, k) => swappable(k) && out.has(x));
    if (i < 0) i = d.ids.findIndex((x, k) => swappable(k) && byId.get(x).tier === tier);
    if (i < 0) i = d.ids.findIndex((_, k) => swappable(k));
    if (i < 0) { report.push(`${d.date}: could not fit pinned ${id}`); continue; }
    report.push(`${d.date} (locked): ${d.ids[i]} → ${id} (pinned)`);
    d.ids[i] = id;
    d.clues[i] = -1; // chosen below, once uses are known
  }
  // Keep the rounds running easy → hard after a swap.
  const order = d.ids.map((x, k) => [x, d.clues[k]]).sort((a, c) => DAY_TIERS.indexOf(byId.get(a[0]).tier) - DAY_TIERS.indexOf(byId.get(c[0]).tier));
  d.ids = order.map((o) => o[0]); d.clues = order.map((o) => o[1]);
  d.ids.forEach((x, k) => { if (!want.has(x) && byId.get(x).retired) report.push(`${d.date} (locked): ${x} is retired but still scheduled; pin a replacement`); });
}
for (const [date] of dayPins) if (date <= today && !kept.some((d) => d.date === date && [...dayPins.get(date)].every((id) => d.ids.includes(id)))) {
  if (date >= addDays(today, -1)) report.push(`${date}: pin ignored, today and earlier never change`);
}

// Clue indexes shown so far, building by building, in date order.
const lastUsed = new Map();
const uses = new Map();
const needClue = [];
const pickClue = (b, date) => {
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
};
for (const d of kept) d.ids.forEach((id, i) => {
  lastUsed.set(id, dayNum(d.date));
  if (d.clues[i] === -1) d.clues[i] = pickClue(byId.get(id), d.date);
  else uses.set(id, [...(uses.get(id) ?? []), d.clues?.[i] ?? 0]);
});

// ---------- plan the future ----------
const warnings = [];
let gapBreaks = 0;
const planned = [];
let firstRepeat = null;
// Continue after the last kept day; if the schedule lapsed, start today (lapsed days used the fallback).
let date = kept.length ? addDays(kept[kept.length - 1].date, 1) : today;
if (date < today) date = today;
// Buildings pinned to a later date stay out of the days before it.
const reservedUntil = new Map();
for (const [d, ids] of dayPins) if (d >= date) for (const id of ids) if (!reservedUntil.has(id) || reservedUntil.get(id) > d) reservedUntil.set(id, d);

for (; date <= planUntil; date = addDays(date, 1)) {
  const n = dayNum(date);
  const day = [];
  const rested = (c) => n - c.last >= MIN_GAP_DAYS;
  const apart = (c) => day.every((o) => distanceKm(o, c.b) >= MIN_SPREAD_KM);
  const allowed = (b) => !b.retired && !day.includes(b) && !(reservedUntil.get(b.id) >= date) && !(notBefore.get(b.id) > date) && !dayOut.get(date)?.has(b.id);
  const bestFor = (tier) => {
    // Oldest use first; ties (e.g. never used) in a stable per-date shuffle.
    let cands = pool
      .filter((b) => b.tier === tier && allowed(b))
      .map((b) => ({ b, last: lastUsed.get(b.id) ?? -Infinity, tie: hash(`${date}:${b.id}`) }))
      .sort((x, y) => x.last - y.last || x.tie - y.tie);
    if (!cands.length) throw new Error(`${date}: no ${tier} buildings left`);
    // A fresh building beats spread (user's rule: no repeats while fresh ones are left);
    // among repeats, spread matters more to players than the gap, so the gap gives way first.
    const fresh = (c) => c.last === -Infinity;
    return cands.find((c) => fresh(c) && apart(c)) ?? cands.find(fresh) ?? cands.find((c) => rested(c) && apart(c)) ?? cands.find(apart) ?? cands[0];
  };
  const slots = [...DAY_TIERS];
  // Pinned buildings (manual pins and Instagram posts) go in first.
  for (const id of dayPins.get(date) ?? []) {
    const b = byId.get(id);
    if ((lastUsed.get(id) ?? -Infinity) !== -Infinity) firstRepeat ??= date;
    day.push(b);
    lastUsed.set(id, n);
    reservedUntil.delete(id);
    slots.splice(slots.includes(b.tier) ? slots.indexOf(b.tier) : slots.length - 1, 1);
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
  planned.push({ date, ids: day.map((b) => b.id), clues: day.map((b) => pickClue(b, date)) });
}

const all = [...kept, ...planned];
writeFileSync(new URL('data/schedule.json', root), '[\n' + all.map((d) => '  ' + JSON.stringify(d)).join(',\n') + '\n]\n');

// ---------- report ----------
const live = pool.filter((b) => !b.retired);
const used = new Set(all.flatMap((d) => d.ids));
const fresh = live.filter((b) => !used.has(b.id));
const freshBy = Object.fromEntries([...new Set(DAY_TIERS)].map((t) => [t, fresh.filter((b) => b.tier === t).length]));
console.log(`schedule: ${all.length} days, ${kept.length} kept (locked through ${frozenUntil}${from ? `, replanned from ${from}` : ''}${keep ? ', --keep' : ''}), ${planned.length} planned, last day ${all[all.length - 1]?.date}`);
console.log(`pool: ${live.length} buildings; never used after this plan: ${fresh.length}`, freshBy);
for (const p of problems) console.log('PIN PROBLEM: ' + p);
for (const r of report) console.log(r);
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
