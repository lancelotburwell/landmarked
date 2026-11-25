// Renders the Instagram reels in data/social.json ("kind": "reel") with make-reel.mjs, for
// the "Render Instagram reels" Action (.github/workflows/reels.yml), which runs one job per
// reel and uploads each video to the GitHub release "reels"; the site then posts it at its
// time (api/instagram.ts downloads it from there and uploads it to Instagram).
//
//   node scripts/render-reels.mjs <key> [url]   render one reel (a site preview must run at
//                                               url, default http://localhost:4173/): writes
//                                               social/out/<key>.mp4 and social/out/<key>.json
//   node scripts/render-reels.mjs --merge       merge every social/out/*.json into
//                                               data/social-captions.json
//
// A reel entry: { date, time, kind: "reel", template: "where"|"who", id, line, crop?, photo?,
// clue?, opener?, decoys? }. id must be a building whose day has been played before date
// (check-plan enforces it). line is the caption's hook. For "where": crop [x, y, width] of
// the close-up (fractions of the photo, a 4:5 frame widened to 9:16), from photo ("File:…",
// a high-resolution Commons detail) or else the game's photo. clue: which of the building's
// clues (default: the one shown on its most recent day). The answer letter goes into the
// caption entry's "notes" (public repo, but only played buildings get reels).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, read, isReel, postKey, postTime } from './lib/plan.mjs';

export const RELEASE = 'reels';
export const videoUrl = (key) => `https://github.com/${process.env.GITHUB_REPOSITORY ?? 'lancelotburwell/landmarked'}/releases/download/${RELEASE}/${key}.mp4`;
const path = (p) => fileURLToPath(new URL(p, root));
mkdirSync(new URL('social/out/', root), { recursive: true });

if (process.argv[2] === '--merge') {
  const capFile = new URL('data/social-captions.json', root);
  const merged = new Map((existsSync(capFile) ? JSON.parse(readFileSync(capFile, 'utf8')) : []).map((c) => [c.key ?? c.date, c]));
  const files = existsSync(new URL('social/out/', root)) ? readdirSync(new URL('social/out/', root)).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) { const c = JSON.parse(readFileSync(new URL(`social/out/${f}`, root), 'utf8')); merged.set(c.key, c); }
  writeFileSync(capFile, JSON.stringify([...merged.values()].sort((a, b) => (a.key ?? a.date).localeCompare(b.key ?? b.date)), null, 1) + '\n');
  console.log(`merged ${files.length} reel caption(s)`);
  process.exit(0);
}

const [key, url = 'http://localhost:4173/'] = process.argv.slice(2);
const p = read('data/social.json').find((x) => isReel(x) && postKey(x) === key);
if (!p) { console.error(`no reel ${key} in data/social.json`); process.exit(1); }
const b = read('data/buildings.json').find((x) => x.id === p.id);
if (!b) { console.error(`${key}: unknown building ${p.id}`); process.exit(1); }
if (!p.line) { console.error(`${key}: add the caption's hook as "line"`); process.exit(1); }

// The clue it was played with most recently, unless the entry picks one.
const played = read('data/schedule.json').filter((d) => d.date < p.date && d.ids.includes(p.id)).at(-1);
if (!played) { console.error(`${key}: ${p.id} hasn't been played before ${p.date}`); process.exit(1); }
const clue = p.clue ?? (played.clues?.[played.ids.indexOf(p.id)] ?? 0) % b.clues.length;

const env = { ...process.env, REELS_TO: '', HOOK: p.line, CLUE: String(clue) };
if (p.crop) env.CROP = p.crop.join(',');
if (p.opener) env.OPENER = p.opener;
if (p.decoys) env.DECOYS = p.decoys.join(',');
if (p.template === 'where') {
  // The close-up: the entry's own Commons detail (as <id>-reel.jpg), else the game's photo.
  const fetchPhoto = (extra) => {
    for (let i = 0; i < 4; i++) {
      try { execFileSync('node', [path('scripts/social-photos.mjs'), p.id], { stdio: 'inherit', env: { ...process.env, W: '3840', ...extra } }); return; }
      catch { execFileSync('node', ['-e', 'setTimeout(()=>{},20000)']); } // Wikimedia rate limits
    }
    throw new Error(`${key}: could not download the photo`);
  };
  if (p.photo) fetchPhoto({ FILE: p.photo });
  else fetchPhoto({});
  if (!p.crop) { console.error(`${key}: a "where" reel needs a crop`); process.exit(1); }
}

execFileSync('node', [path('scripts/make-reel.mjs'), p.template, p.id, url], { stdio: 'inherit', env });

const base = `social/reels/${p.id}-${p.template}`;
const txt = readFileSync(new URL(`${base}.txt`, root), 'utf8');
const [caption, notes = ''] = txt.split('\n\n--- notes, not part of the caption ---\n');
renameSync(new URL(`${base}.mp4`, root), new URL(`social/out/${key}.mp4`, root));
const entry = {
  key, kind: 'reel', date: p.date, time: postTime(p), id: p.id, name: b.name, tier: b.tier, template: p.template,
  video: videoUrl(key), clue: b.clues[clue], text: caption.trim(), notes: notes.trim(),
};
writeFileSync(new URL(`social/out/${key}.json`, root), JSON.stringify(entry, null, 1));
console.log(`${key}: social/out/${key}.mp4 and .json`);
