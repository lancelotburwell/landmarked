// Shared by the planning scripts: schedule.mjs, check-plan.mjs, next-batch.mjs, export-days.mjs.
import { readFileSync, existsSync } from 'node:fs';

export const DAY_TIERS = ['easy', 'easy', 'medium', 'medium', 'hard']; // rounds run easy → hard
export const BUFFER_DAYS = 28; // how far ahead the plan reaches
export const FROZEN_DAYS = 8; // today + 8 are locked: puzzles and Instagram posts are final
export const STOCK_DAYS = 21; // fresh (never used) buildings to keep in hand beyond the locked days
export const MIN_GAP_DAYS = 180; // a repeat should not feel like one
export const MIN_SPREAD_KM = 1500;

export const root = new URL('../../', import.meta.url);
export const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
export const readOr = (p, fallback) => (existsSync(new URL(p, root)) ? read(p) : fallback);

// Local calendar days, like the game.
export const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return key(new Date(y, m - 1, d + n)); };
export const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };
export const today = () => key(new Date());
const todayKey = today;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function distanceKm(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// data/pins.json: manual decisions the scheduler always respects. One entry per line:
//   { "date": "2026-12-03", "ids": ["reichstag"], "note": "why" }   these buildings run that day
//   { "id": "white-house", "notBefore": "2027-01-21", "note": "why" }  not scheduled before that date
// An Instagram post (data/social.json) pins its building to its date the same way.
export function readPins(pool) {
  const byId = new Map(pool.map((b) => [b.id, b]));
  const dayPins = new Map(); // date → Set(ids)
  const notBefore = new Map(); // id → date
  const problems = [];
  const add = (date, id, src) => {
    if (!byId.has(id)) return problems.push(`${src}: unknown building "${id}"`);
    if (byId.get(id).retired) return problems.push(`${src}: "${id}" is retired`);
    if (!dayPins.has(date)) dayPins.set(date, new Set());
    dayPins.get(date).add(id);
  };
  for (const p of readOr('data/pins.json', [])) {
    if (p.date) {
      if (!isDate(p.date) || !Array.isArray(p.ids)) { problems.push(`pins.json: bad entry ${JSON.stringify(p)}`); continue; }
      for (const id of p.ids) add(p.date, id, `pins.json ${p.date}`);
    } else if (p.id && isDate(p.notBefore)) {
      if (!byId.has(p.id)) problems.push(`pins.json: unknown building "${p.id}"`);
      else notBefore.set(p.id, p.notBefore);
    } else problems.push(`pins.json: bad entry ${JSON.stringify(p)}`);
  }
  for (const s of readOr('data/social.json', [])) add(s.date, s.id, `social.json ${s.date}`);
  for (const [date, ids] of dayPins) {
    if (ids.size > 5) problems.push(`${date}: more than five buildings pinned`);
    const tiers = [...ids].map((id) => byId.get(id).tier);
    for (const t of new Set(tiers)) if (tiers.filter((x) => x === t).length > DAY_TIERS.filter((x) => x === t).length) problems.push(`${date}: too many ${t} buildings pinned (a day has ${DAY_TIERS.filter((x) => x === t).length})`);
  }
  return { dayPins, notBefore, problems };
}

// Buildings never used on any day up to `until`.
export function freshAfter(pool, schedule, until) {
  const used = new Set(schedule.filter((d) => d.date <= until).flatMap((d) => d.ids));
  return pool.filter((b) => !b.retired && !used.has(b.id));
}

// The plan's health: used by check-plan.mjs (nightly, fails on errors) and by
// export-days.mjs (public/plan.json for the planner page).
export function checkPlan({ pool, schedule, socialList = readOr('data/social.json', []), today = todayKey(), hasPhoto = (id) => existsSync(new URL(`public/photos/${id}.jpg`, root)) }) {
  const byId = new Map(pool.map((b) => [b.id, b]));
  const byDate = new Map(schedule.map((d) => [d.date, d]));
  const social = new Map(socialList.map((s) => [s.date, s.id]));
  const { problems } = readPins(pool);

  const locked = addDays(today, FROZEN_DAYS);
  const errors = [], warns = [];

  for (const p of problems) errors.push(`pin: ${p}`);

  // Every day of the plan has five distinct, active, known buildings.
  for (let d = today, i = 0; i <= BUFFER_DAYS; d = addDays(d, 1), i++) {
    const day = byDate.get(d);
    if (!day) { errors.push(`${d}: no puzzle planned`); continue; }
    const ids = day.ids ?? [];
    if (ids.length !== 5 || new Set(ids).size !== 5) errors.push(`${d}: needs five different buildings, has ${ids.length}`);
    for (const id of ids) {
      const b = byId.get(id);
      if (!b) errors.push(`${d}: unknown building ${id}`);
      else if (b.retired && d > today) (d <= locked ? errors : warns).push(`${d}: ${id} is retired (${b.retired})`);
    }
  }

  // Instagram: a post for every locked day; today and tomorrow are urgent.
  for (let d = today; d <= locked; d = addDays(d, 1)) {
    const id = social.get(d);
    const day = byDate.get(d);
    if (!id) (d <= addDays(today, 1) ? errors : warns).push(`${d}: no Instagram post`);
    else if (day && !day.ids.includes(id)) errors.push(`${d}: the Instagram post shows ${id}, which is not in that day's puzzle`);
  }

  // Stock: days of never-used buildings beyond the locked days.
  const fresh = freshAfter(pool, schedule, locked);
  const stockDays = Math.floor(fresh.length / 5);
  const stockMsg = `fresh stock: ${fresh.length} buildings never used through ${locked}, about ${stockDays} days`;
  if (stockDays < 7) errors.push(`${stockMsg} (add buildings now)`);
  else if (stockDays < STOCK_DAYS) warns.push(`${stockMsg}, under the ${STOCK_DAYS}-day target`);

  // Repeats in the plan: soon, and without a fresh clue.
  // Locked days are listed one by one; later ones only counted, since they are
  // redrawn every night and go away as the stock grows.
  const lastSeen = new Map(), shown = new Map();
  const laterRepeats = [];
  for (const day of schedule) {
    day.ids.forEach((id, i) => {
      const c = day.clues?.[i] ?? 0;
      if (day.date > today && lastSeen.has(id)) {
        const gap = dayNum(day.date) - dayNum(lastSeen.get(id));
        const issues = [gap < MIN_GAP_DAYS && `after only ${gap} days`, (shown.get(id) ?? []).includes(c) && 'with a clue it has shown before'].filter(Boolean);
        if (issues.length && day.date <= locked) warns.push(`${day.date}: ${id} repeats ${issues.join(', ')}`);
        if (day.date > locked) laterRepeats.push(day.date);
      }
      lastSeen.set(id, day.date);
      shown.set(id, [...(shown.get(id) ?? []), c]);
    });
  }
  if (laterRepeats.length) warns.push(`${laterRepeats.length} repeats planned after the locked days, the first on ${laterRepeats[0]} (more stock replaces them)`);

  // Locked days: spread and photos.
  for (let d = addDays(today, 1); d <= addDays(today, 14); d = addDays(d, 1)) {
    const day = byDate.get(d);
    if (!day) continue;
    const bs = day.ids.map((id) => byId.get(id)).filter(Boolean);
    if (d <= locked) for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const km = distanceKm(bs[i], bs[j]);
      if (km < 500) warns.push(`${d}: ${bs[i].id} and ${bs[j].id} are only ${Math.round(km)} km apart`);
    }
    for (const b of bs) if (!hasPhoto(b.id)) warns.push(`${d}: ${b.id} has no photo`);
  }

  const firstRepeat = schedule.find((d) => d.date > today && d.ids.some((id) => schedule.some((e) => e.date < d.date && e.ids.includes(id))))?.date;
  const summary = [
    `plan: ${schedule.filter((d) => d.date >= today).length} days from today, last ${schedule[schedule.length - 1]?.date}; locked through ${locked}`,
    stockMsg,
    `first repeat: ${firstRepeat ?? 'none planned'}`,
  ];

  const dedupe = (a) => [...new Set(a)];
  return { summary, errors: dedupe(errors), warns: dedupe(warns), stockDays, locked, firstRepeat: firstRepeat ?? null };
}
