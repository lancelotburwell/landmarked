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
//   node scripts/make-social.mjs [date ...]     (default: every date from today on)
//
// Writes public/social/<date>-1.jpg and -2.jpg (served from landmarked.land so
// Metricool can fetch them) and social/out/captions.json (gitignored) with each
// post's caption: the teaser line, the catchphrase and link, hashtags, and the photo credit that CC BY and
// CC BY-SA require (creator, licence, "cropped").
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const posts = JSON.parse(read('data/social.json'));
if (posts.some((p) => !p.first)) {
  for (const p of posts) p.first ??= Math.random() < 0.5 ? 'clue' : 'photo';
  writeFileSync(new URL('data/social.json', root), `[\n${posts.map((p) => '  ' + JSON.stringify(p)).join(',\n')}\n]\n`);
}
const buildings = Object.fromEntries(JSON.parse(read('data/buildings.json')).map((b) => [b.id, b]));
const credits = JSON.parse(read('public/photos/credits.json'));
const schedule = Object.fromEntries(JSON.parse(read('data/schedule.json')).map((d) => [d.date, d]));
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');
const W = 1080, H = 1350;
mkdirSync(new URL('public/social/', root), { recursive: true });
mkdirSync(new URL('social/out/', root), { recursive: true });

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const dates = process.argv.slice(2);
const todo = posts.filter((p) => (dates.length ? dates.includes(p.date) : p.date >= today));
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const out = (p) => fileURLToPath(new URL(p, root));

const css = `
@font-face { font-family: Plex; font-weight: 400; src: url(data:font/woff2;base64,${font(400)}) format('woff2'); }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #fff; }
.clue { box-sizing: border-box; width: 100%; height: 100%; padding: 0 120px; display: flex; align-items: center; justify-content: center;
  text-align: center; font-family: Plex; font-weight: 400; font-size: 46px; line-height: 1.5; color: #161616; letter-spacing: -0.01em; }
.photo { position: relative; width: 100%; height: 100%; overflow: hidden; }
.photo img { position: absolute; }`;

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
  await page.screenshot({ path: out(`public/social/${p.date}-1.jpg`), type: 'jpeg', quality: 90 });

  const src = `data:image/jpeg;base64,${readFileSync(new URL(`social/src/${p.id}.jpg`, root)).toString('base64')}`;
  await page.setContent(`<style>${css}</style><div class="photo"><img></div>`);
  const [iw, ih] = await page.evaluate(async (s) => {
    const img = document.images[0]; img.src = s; await img.decode(); return [img.naturalWidth, img.naturalHeight];
  }, src);
  const [x, y, w] = p.crop;
  const scale = W / (w * iw);
  if (x + w > 1.001 || y * ih + H / scale > ih + 1) throw new Error(`${p.date} ${p.id}: crop runs off the photo`);
  await page.evaluate((st) => Object.assign(document.images[0].style, st),
    { width: `${iw * scale}px`, left: `${-x * iw * scale}px`, top: `${-y * ih * scale}px` });
  await page.screenshot({ path: out(`public/social/${p.date}-2.jpg`), type: 'jpeg', quality: 90 });

  const c = credits[p.id];
  const artist = c.artist
    .replace(/^The original uploader was (.*?) at .*$/, '$1')
    .replace(/^No machine-readable author provided\. (.*?) assumed.*$/, '$1');
  const credit = /public domain|cc0/i.test(c.license) ? '📷 Wikimedia Commons' : `📷 ${artist} · ${c.license} · cropped · Wikimedia Commons`;
  const text = `${p.line}

Can you find it on the globe?
Play at landmarked.land (link in bio)

#architecture #geography #dailypuzzle #guessthebuilding

${credit}`;
  captions.push({ date: p.date, id: p.id, name: b.name, round: round + 1, sourcePx: Math.round(w * iw), first: p.first, images: (p.first === 'photo' ? [2, 1] : [1, 2]).map((n) => `https://landmarked.land/social/${p.date}-${n}.jpg`), clue, text });
  console.log(p.date, p.id, `round ${round + 1}`, `${p.first} first`, `crop is ${Math.round(w * iw)} px of source${w * iw < 500 ? ' (soft)' : ''}`);
}
writeFileSync(new URL('social/out/captions.json', root), JSON.stringify(captions, null, 2));
await browser.close();
