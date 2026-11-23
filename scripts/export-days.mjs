// Turns data/buildings.json + data/schedule.json into what the game loads:
//   public/days/<YYYY-MM-DD>.json   that day's five buildings, each with its one clue
//   public/pool.json                every active building (practice rounds, and the
//                                   fallback if the schedule ever runs out)
// Runs automatically before `npm run dev` and `npm run build` (so on every Vercel
// deploy); the output is generated, not committed.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const pool = read('data/buildings.json');
const byId = new Map(pool.map((b) => [b.id, b]));
const schedule = read('data/schedule.json');

const withClue = ({ clues, retired, ...b }, i = 0) => ({ ...b, clue: clues[i] ?? clues[0] });

const dir = new URL('public/days/', root);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const d of schedule) {
  const buildings = d.ids.map((id, i) => {
    const b = byId.get(id);
    if (!b) throw new Error(`${d.date}: unknown building "${id}"`);
    return withClue(b, d.clues?.[i] ?? 0);
  });
  writeFileSync(new URL(`${d.date}.json`, dir), JSON.stringify({ date: d.date, buildings }));
}
writeFileSync(new URL('public/pool.json', root), JSON.stringify(pool.filter((b) => !b.retired).map((b) => withClue(b))));

// public/plan.json for the planner page (public/planner.html): the last few days and
// the whole plan ahead, with the Instagram posts, pins and the health check. It shows
// nothing the day files don't already.
{
  const { checkPlan, readOr: readOrP, addDays, dayNum, distanceKm, today: todayKey } = await import('./lib/plan.mjs');
  const { existsSync } = await import('node:fs');
  const todayK = todayKey();
  const social = new Map(readOrP('data/social.json', []).map((s) => [s.date, s]));
  const pins = readOrP('data/pins.json', []);
  const health = checkPlan({ pool, schedule });
  const lastSeen = new Map(), shown = new Map();
  const days = [];
  for (const d of schedule) {
    const bs = d.ids.map((id, i) => {
      const b = byId.get(id), c = d.clues?.[i] ?? 0;
      const prev = lastSeen.get(id);
      const repeat = prev ? { prev, gap: dayNum(d.date) - dayNum(prev), sameClue: (shown.get(id) ?? []).includes(c) } : null;
      lastSeen.set(id, d.date);
      shown.set(id, [...(shown.get(id) ?? []), c]);
      return { id, name: b.name, city: b.city, country: b.country, tier: b.tier, clue: b.clues[c] ?? b.clues[0], clueNo: c + 1, clues: b.clues.length, photo: existsSync(new URL(`public/photos/${id}.jpg`, root)), repeat, lat: b.lat, lon: b.lon };
    });
    if (d.date < addDays(todayK, -3)) continue;
    let minKm = Infinity;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) minKm = Math.min(minKm, distanceKm(bs[i], bs[j]));
    const s = social.get(d.date);
    days.push({
      date: d.date, locked: d.date <= health.locked, past: d.date < todayK,
      social: s ? { id: s.id, line: s.line, first: s.first ?? null } : null,
      pinned: pins.filter((p) => p.date === d.date).flatMap((p) => p.ids),
      minKm: Math.round(minKm), buildings: bs.map(({ lat, lon, ...b }) => b),
    });
  }
  writeFileSync(new URL('public/plan.json', root), JSON.stringify({
    generated: new Date().toISOString(), today: todayK, locked: health.locked, stockDays: health.stockDays,
    firstRepeat: health.firstRepeat, summary: health.summary, errors: health.errors, warns: health.warns,
    pins, pool: { active: pool.filter((b) => !b.retired).length, retired: pool.filter((b) => b.retired).length },
    days,
  }));
}

// Warn when the planned days are running out.
const p = (n) => String(n).padStart(2, '0');
const now = new Date();
const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
const soonKey = `${soon.getFullYear()}-${p(soon.getMonth() + 1)}-${p(soon.getDate())}`;
const last = schedule[schedule.length - 1]?.date ?? '';
console.log(`export-days: ${schedule.length} days (last ${last}), ${pool.filter((b) => !b.retired).length} buildings in pool.json`);
if (last < soonKey) console.warn(`WARNING: the schedule ends ${last || 'now'}. Run npm run schedule (after that the game falls back to a random five).`);
