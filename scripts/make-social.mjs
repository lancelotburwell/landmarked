// Instagram sneak peeks: one of each day's five buildings, as a two-slide
// carousel (1080×1350, 4:5):
//   slide 1: that day's clue for it, IBM Plex Mono, centred on white;
//   slide 2: a close-up crop of its photo that the website never shows.
//
// data/social.json is the record, one line per date: { date, id, crop, line }, where
// id must be in that day's puzzle and crop = [x, y, width] as fractions of the
// large photo in social/src/<id>.jpg (get it with scripts/social-photos.mjs);
// the height follows from the 4:5 frame. line is the caption's teaser: one
// surprising fact about the building that doesn't give it away or repeat the clue.
// first is "clue" or "photo": which slide leads. Missing ones are picked at
// random and written back, so the feed varies and a re-render keeps the order.
//
//   node scripts/make-social.mjs [key ...]      (a post key or a date; default: every carousel from today on)
// Several carousels a day are fine, each at its "time"; reels ("kind": "reel") are made by render-reels.mjs.
//
// Writes public/social/<date>-1.jpg and -2.jpg (served from landmarked.land so
// Instagram can fetch them) and data/social-captions.json (committed, merged by date) with each
// post's caption: the teaser line, the catchphrase with the difficulty square, the link, hashtags, and the photo credit that CC BY and
// CC BY-SA require (creator, licence, "cropped").
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { isReel, postKey, postTime } from './lib/plan.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const posts = JSON.parse(read('data/social.json'));
if (posts.some((p) => !isReel(p) && !p.first)) {
  for (const p of posts) if (!isReel(p)) p.first ??= Math.random() < 0.5 ? 'clue' : 'photo';
  writeFileSync(new URL('data/social.json', root), `[\n${posts.map((p) => '  ' + JSON.stringify(p)).join(',\n')}\n]\n`);
}
const buildings = Object.fromEntries(JSON.parse(read('data/buildings.json')).map((b) => [b.id, b]));
const credits = JSON.parse(read('public/photos/credits.json'));
const schedule = Object.fromEntries(JSON.parse(read('data/schedule.json')).map((d) => [d.date, d]));
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');
const W = 1080, H = 1350;
// The building's difficulty, in the app's tier colours (src/game.ts TIER_COLOR:
// easy #8cc5a0, medium #e3b261, hard #e2775c) as the nearest emoji squares.
const TIER_SQUARE = { easy: '🟩', medium: '🟨', hard: '🟥' };
mkdirSync(new URL('public/social/', root), { recursive: true });

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const dates = process.argv.slice(2);
const todo = posts.filter((p) => !isReel(p) && (dates.length ? dates.includes(postKey(p)) || dates.includes(p.date) : p.date >= today));
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const out = (p) => fileURLToPath(new URL(p, root));

const css = `
@font-face { font-family: Plex; font-weight: 400; src: url(data:font/woff2;base64,${font(400)}) format('woff2'); }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #fff; }
.clue { box-sizing: border-box; width: 100%; height: 100%; padding: 0 120px; display: flex; align-items: center; justify-content: center;
  text-align: center; font-family: Plex; font-weight: 400; font-size: 46px; line-height: 1.5; color: #161616; letter-spacing: -0.01em; }
.photo { position: relative; width: 100%; height: 100%; overflow: hidden; }
.photo img { position: absolute; }`;

// photo: "File:…" in a post picks a different Commons photo than the game's: a closer,
// high-resolution detail, so the crop can be tight without going soft (the user's rule,
// 2026-11-25: the photo must not give the building away). It's downloaded at 3840 px to
// social/src/<date>.jpg with its credit in <date>.json; CC0/PD/CC BY/CC BY-SA only.
const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };
async function postPhoto(p) {
  const img = new URL(`social/src/${postKey(p)}.jpg`, root), meta = new URL(`social/src/${postKey(p)}.json`, root);
  if (existsSync(img) && existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).file === p.photo) return JSON.parse(readFileSync(meta, 'utf8'));
  const q = new URLSearchParams({ action: 'query', titles: p.photo, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '3840', format: 'json' });
  for (let attempt = 0; ; attempt++) {
    try {
      const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: UA })).json();
      const info = Object.values(j.query.pages)[0].imageinfo?.[0];
      if (!info) throw new Error(`${p.date}: ${p.photo} not found on Commons`);
      const m = info.extmetadata;
      const license = m.LicenseShortName?.value ?? '';
      if (!/^(cc0|cc by(-sa)? [\d.]+|public domain|pd)/i.test(license)) throw new Error(`${p.date}: ${p.photo} has licence "${license}", not allowed`);
      const artist = (m.Artist?.value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const res = await fetch(info.width <= 3840 ? info.url : info.thumburl, { headers: UA });
      if (!res.ok) throw new Error(`download ${res.status}`);
      writeFileSync(img, Buffer.from(await res.arrayBuffer()));
      const c = { file: p.photo, artist, license, page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.photo.replace(/ /g, '_'))}` };
      writeFileSync(meta, JSON.stringify(c, null, 1));
      return c;
    } catch (e) {
      if (attempt >= 4 || /not allowed|not found/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 15000)); // Wikimedia rate limits
    }
  }
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const captions = [];

for (const p of todo) {
  const day = schedule[p.date];
  const round = day?.ids.indexOf(p.id) ?? -1;
  if (round < 0) throw new Error(`${p.date}: ${p.id} isn't in that day's puzzle`);
  const b = buildings[p.id];
  if (!p.line) throw new Error(`${p.date}: add a teaser "line" in data/social.json`);
  const clue = b.clues[day.clues[round] % b.clues.length];

  await page.setContent(`<style>${css}</style><div class="clue"><p>${esc(clue)}</p></div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out(`public/social/${postKey(p)}-1.jpg`), type: 'jpeg', quality: 90 });

  const own = p.photo ? await postPhoto(p) : null;
  const src = `data:image/jpeg;base64,${readFileSync(new URL(`social/src/${own ? postKey(p) : p.id}.jpg`, root)).toString('base64')}`;
  await page.setContent(`<style>${css}</style><div class="photo"><img></div>`);
  const [iw, ih] = await page.evaluate(async (s) => {
    const img = document.images[0]; img.src = s; await img.decode(); return [img.naturalWidth, img.naturalHeight];
  }, src);
  const [x, y, w] = p.crop;
  const scale = W / (w * iw);
  if (x + w > 1.001 || y * ih + H / scale > ih + 1) throw new Error(`${p.date} ${p.id}: crop runs off the photo`);
  // Sharp images only (the user's rule, 2026-11-25): the slide is 1,080 px wide, so the crop
  // must cover at least that much of the source. Find a higher-resolution "photo" instead.
  if (w * iw < 1080 && p.date >= today) throw new Error(`${postKey(p)} ${p.id}: the crop is only ${Math.round(w * iw)} px of the source, under 1,080: soft. Use a sharper photo or a wider crop.`);
  await page.evaluate((st) => Object.assign(document.images[0].style, st),
    { width: `${iw * scale}px`, left: `${-x * iw * scale}px`, top: `${-y * ih * scale}px` });
  await page.screenshot({ path: out(`public/social/${postKey(p)}-2.jpg`), type: 'jpeg', quality: 90 });

  const c = own ?? credits[p.id];
  const artist = c.artist
    .replace(/^The original uploader was (.*?) at .*$/, '$1')
    .replace(/^No machine-readable author provided\. (.*?) assumed.*$/, '$1')
    .replace(/^Photo(graph)? by /i, '').replace(/\.$/, '');
  const credit = /public domain|cc0/i.test(c.license) ? '📷 Wikimedia Commons' : `📷 ${artist} · ${c.license} · cropped · Wikimedia Commons`;
  const text = `${p.line}

Can you find it on the globe? ${TIER_SQUARE[b.tier]}
Play at landmarked.land (link in bio)

#architecture #geography #dailypuzzle #guessthebuilding

${credit}`;
  captions.push({ key: postKey(p), kind: 'carousel', date: p.date, time: postTime(p), id: p.id, name: b.name, tier: b.tier, round: round + 1, sourcePx: Math.round(w * iw), first: p.first, images: (p.first === 'photo' ? [2, 1] : [1, 2]).map((n) => `https://landmarked.land/social/${postKey(p)}-${n}.jpg`), clue, text });
  console.log(postKey(p), p.id, `round ${round + 1}`, `${p.first} first`, `crop is ${Math.round(w * iw)} px of source${w * iw < 1080 ? ' (soft: under 1080)' : ''}`);
}
// Merge into the committed captions file, one entry per post key (reels are merged in by render-reels.mjs).
const capFile = new URL('data/social-captions.json', root);
const merged = new Map((existsSync(capFile) ? JSON.parse(readFileSync(capFile, 'utf8')) : []).map((c) => [c.key ?? c.date, c]));
for (const c of captions) merged.set(c.key, c);
writeFileSync(capFile, JSON.stringify([...merged.values()].sort((a, b) => (a.key ?? a.date).localeCompare(b.key ?? b.date)), null, 1) + '\n');
await browser.close();
