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

// Warn when the planned days are running out.
const p = (n) => String(n).padStart(2, '0');
const now = new Date();
const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
const soonKey = `${soon.getFullYear()}-${p(soon.getMonth() + 1)}-${p(soon.getDate())}`;
const last = schedule[schedule.length - 1]?.date ?? '';
console.log(`export-days: ${schedule.length} days (last ${last}), ${pool.filter((b) => !b.retired).length} buildings in pool.json`);
if (last < soonKey) console.warn(`WARNING: the schedule ends ${last || 'now'}. Run npm run schedule (after that the game falls back to a random five).`);
