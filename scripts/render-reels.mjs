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
// A reel entry is either a classic template (make-reel.mjs):
//   { date, time, kind: "reel", template: "where"|"who", id, line, crop?, photo?, clue?, opener?, decoys? }
// or any game format of make-reel-formats.mjs that shows the globe, with its own content:
//   { date, time, kind: "reel", format: "pins"|"stop"|"distance"|…, ids: [...], cfg: {...}, line,
//     question, answer, mood?, photos?: { <id>: "File:…" } }
// cfg has the same shape as that format's cfg() in make-reel-formats.mjs; "@photo:<id>" in it
// stands for that building's photo (photos[id] picks a Commons close-up for it, else the
// game's photo is used). Every id must have been played before date. id must be a building whose day has been played before date
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
if (p.format) { await renderFormat(p); process.exit(0); }
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
  // Sharp close-ups only (the user's rule, 2026-11-25): at least ~1,000 px of the source.
  const img = readFileSync(new URL(`social/src/${p.id}${p.photo ? '-reel' : ''}.jpg`, root));
  const px = Math.round(p.crop[2] * jpegSize(img).w);
  if (px < 1000) { console.error(`${key}: the close-up is only ${px} px of the source (needs 1,000+): find a sharper photo or widen the crop`); process.exit(1); }
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

// ---------- a game format (make-reel-formats.mjs) ----------
async function renderFormat(p) {
  if (!p.line || !p.question || !p.answer || !Array.isArray(p.ids) || !p.ids.length || !p.cfg) {
    console.error(`${key}: a format reel needs ids, cfg, line, question and answer`); process.exit(1);
  }
  const all = read('data/buildings.json'), sched = read('data/schedule.json');
  for (const id of p.ids) {
    if (!all.some((x) => x.id === id)) { console.error(`${key}: unknown building ${id}`); process.exit(1); }
    if (!sched.some((d) => d.date < p.date && d.ids.includes(id))) { console.error(`${key}: ${id} hasn't been played before ${p.date}`); process.exit(1); }
  }
  // Every photo the reel shows, sharp enough for a full-screen close-up.
  for (const id of new Set((JSON.stringify(p.cfg).match(/@photo:[\w-]+/g) ?? []).map((m) => m.slice(7)))) {
    const extra = p.photos?.[id] ? { FILE: p.photos[id] } : {};
    for (let i = 0; ; i++) {
      try { execFileSync('node', [path('scripts/social-photos.mjs'), id], { stdio: 'inherit', env: { ...process.env, W: '3840', ...extra } }); break; }
      catch (e) { if (i >= 3) throw e; execFileSync('node', ['-e', 'setTimeout(()=>{},20000)']); }
    }
  }
  execFileSync('node', [path('scripts/make-reel-formats.mjs'), p.format, url], { stdio: 'inherit', env: { ...process.env, REELS_TO: '', REEL_ENTRY: JSON.stringify(p) } });
  const base = `social/reels/${p.format}-${p.ids[0]}`;
  const txt = readFileSync(new URL(`${base}.txt`, root), 'utf8');
  const [caption, notes = ''] = txt.split('\n\n--- notes, not part of the caption ---\n');
  renameSync(new URL(`${base}.mp4`, root), new URL(`social/out/${key}.mp4`, root));
  const bs = p.ids.map((id) => all.find((x) => x.id === id));
  const entry = {
    key, kind: 'reel', date: p.date, time: postTime(p), id: p.ids[0], ids: p.ids, name: bs.map((b) => b.name).join(', '),
    tier: bs.length === 1 ? bs[0].tier : null, format: p.format, video: videoUrl(key), text: caption.trim(), notes: notes.trim(),
  };
  writeFileSync(new URL(`social/out/${key}.json`, root), JSON.stringify(entry, null, 1));
  console.log(`${key}: social/out/${key}.mp4 and .json`);
}

/** Width and height of a JPEG, from its frame header. */
function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('not a JPEG');
}
