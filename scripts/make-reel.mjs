// Renders an Instagram reel (1080×1920, 30 fps MP4) in one of the two templates the
// user chose on 2026-11-23, plus its caption. Neither template shows the answer: the
// question is for the comments. No music (the user adds it in Instagram).
//
//   where  "Where am I?": a close-up crop of the building for 2.5 s, then the globe just
//          spins (no zoom, no pin) with the clue above it and a big gold "Where am I?"
//          below. Loops back to the close-up.
//   who    "Who am I?": the title on top, the clue at the bottom, and one continuous swoop:
//          the globe spins fast and, without pausing, slows while it zooms in, coming to
//          rest at about 3,000 km as a gold pin lands at 6.6 s (line the song's beat drop
//          up there); then it zooms back out, speeding up the same way. Exactly one full
//          turn, so the last frame is the first. The building is never shown.
//
//   npm run build && npx vite preview --port 4173, then
//   GPU=1 node scripts/make-reel.mjs <where|who> <building id> [url]
//
// Options (environment):
//   GPU=1         draw with the graphics card (2–4 min a reel; without it, software, ~8 min)
//   CROP=x,y,w    where: the close-up, as fractions of the large photo (top-left corner and
//                 width of a 4:5 crop, widened to 9:16 around its centre). Choose it on the
//                 grid from python scripts/social-grid.py <id>: a detail, corner or texture;
//                 no crowds, signs or inscriptions. Defaults to the building's carousel crop.
//   HOOK="…"      the caption's first line: one surprising fact from the blurb, 10–20 words,
//                 that doesn't name the building, its architect, city or country. Defaults
//                 to the carousel's teaser line, if the building has had a post.
//   CLUE=n        which of the building's clues (default 0, the first)
//   AT=1,3,6.6    render only those moments (s), as PNGs in social/reels/.frames-<id>/
//
// Writes social/reels/<id>-<template>.mp4 and .txt (the caption; gitignored). Uses the
// large photo from social/src/<id>.jpg (scripts/social-photos.mjs <id>).
// Use easy buildings with good clues, and only post a "who" reel after that building's
// day has been played: the pin gives the location away.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

// ---------- the two templates ----------
const TEMPLATES = {
  where: { title: 'Where am I?', question: 'Where am I? Guess in the comments 👇', closeup: 2.5, total: 11, spin: -12 },
  who: { title: 'Who am I?', question: 'Who am I? Name the building in the comments 👇', total: 11.8, spin: -50,
    swoopIn: 210,    // degrees turned on the way in (the way out turns the rest of the circle)
    restAt: 6.0,     // comes to rest over the pin
    pinAt: 6.6,      // the pin lands
    outAt: 7.8,      // starts zooming back out
    closeAlt: 3_000_000 }, // closer, the map is forest or desert with nothing to place the pin by
};

const [tName, id, url = 'http://localhost:4173/'] = process.argv.slice(2);
const TPL = TEMPLATES[tName];
const b = read('data/buildings.json').find((x) => x.id === id);
if (!TPL || !b) {
  console.error(`usage: node scripts/make-reel.mjs <${Object.keys(TEMPLATES).join('|')}> <building id> [url]`);
  process.exit(1);
}
const post = read('data/social.json').findLast((s) => s.id === id);
const clue = b.clues[Number(process.env.CLUE ?? 0)] ?? b.clues[0];
const crop = process.env.CROP ? process.env.CROP.split(',').map(Number) : post?.crop;
if (tName === 'where' && !crop) { console.error(`${id}: give CROP=x,y,width for the close-up (see the header)`); process.exit(1); }

const bigPhoto = `social/src/${id}.jpg`;
if (tName === 'where' && !existsSync(new URL(bigPhoto, root))) { console.error(`run node scripts/social-photos.mjs ${id} first`); process.exit(1); }
const photo = tName === 'where' ? readFileSync(new URL(bigPhoto, root)).toString('base64') : null;
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');

const FPS = 30;
const W = 1080, H = 1920;
const START_LAT = 18;
const DEG_M = 111_320;
const R_EARTH = 6_378_137;
const SAFE_BOTTOM = 430; // Instagram's caption and buttons cover the bottom of the screen

const frames = path(`social/reels/.frames-${id}/`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: process.env.GPU
    ? ['--ignore-gpu-blocklist', '--enable-webgl', '--enable-gpu', '--use-angle=default']
    : ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__landmarked?.globe, { timeout: 90_000 });

// ---------- overlay: title, clue, pin and the close-up, over the game's own globe ----------
await page.evaluate(async ({ clue, title, photo, crop, regular, semi, W, H }) => {
  const css = document.createElement('style');
  css.textContent = `
    @font-face { font-family: ReelPlex; font-weight: 400; src: url(data:font/woff2;base64,${regular}) format('woff2'); }
    @font-face { font-family: ReelPlex; font-weight: 600; src: url(data:font/woff2;base64,${semi}) format('woff2'); }
    body > * { visibility: hidden; }
    #globe { visibility: visible; position: fixed !important; left: 0 !important; width: 100vw !important; z-index: 10; }
    #globe .pins { display: none; }
    #reel { visibility: visible; position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: ReelPlex, monospace; color: #ece6da; overflow: hidden; }
    #reel .shadow { text-shadow: 0 2px 6px rgb(0 0 0 / 0.9), 0 0 28px rgb(0 0 0 / 0.75); }
    #reel .clue { position: absolute; left: 90px; right: 90px; text-align: center; font-size: 50px; line-height: 1.38; font-weight: 600; z-index: 3; }
    #reel .title { position: absolute; left: 60px; right: 60px; text-align: center; color: #e3b261; font-size: 84px; font-weight: 600; z-index: 3; }
    #reel .pin { position: absolute; left: 0; top: 0; width: 84px; height: 112px; margin: -112px 0 0 -42px; opacity: 0; filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.6)); z-index: 2; }
    #reel .ring { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; border: 5px solid #e3b261; border-radius: 50%; opacity: 0; z-index: 2; }
    #reel .closeup { position: absolute; inset: 0; background-color: #0e1012; background-repeat: no-repeat; z-index: 5; display: none; }
  `;
  document.head.append(css);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reel = document.createElement('div');
  reel.id = 'reel';
  reel.innerHTML = `
    <div class="closeup"></div>
    <div class="title shadow">${esc(title)}</div>
    <div class="clue shadow">${esc(clue)}</div>
    <div class="ring"></div>
    <svg class="pin" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.8 1 11.8 1 20.2 12 31 12 31s11-10.8 11-19.2C23 5.8 18.1 1 12 1z" fill="#e3b261" stroke="#1a1408" stroke-width="1"/><circle cx="12" cy="11.6" r="4.2" fill="#1a1408"/></svg>`;
  document.body.append(reel);
  document.getElementById('intro').hidden = true;

  // The close-up: the 4:5 crop [x, y, width] (fractions of the photo), widened to 9:16
  // around the same centre and kept inside the photo.
  if (photo && crop) {
    const src = `data:image/jpeg;base64,${photo}`;
    const im = new Image();
    im.src = src;
    await im.decode();
    const nw = im.naturalWidth, nh = im.naturalHeight;
    const cw = crop[2] * nw, ch = (cw * 5) / 4;
    const cx = crop[0] * nw + cw / 2, cy = crop[1] * nh + ch / 2;
    let rw = cw, rh = (cw * H) / W;
    if (rh > nh) { rh = nh; rw = (rh * W) / H; }
    const x0 = Math.max(0, Math.min(nw - rw, cx - rw / 2)), y0 = Math.max(0, Math.min(nh - rh, cy - rh / 2));
    const s = W / rw;
    Object.assign(reel.querySelector('.closeup').style, {
      backgroundImage: `url(${src})`, backgroundSize: `${nw * s}px ${nh * s}px`, backgroundPosition: `${-x0 * s}px ${-y0 * s}px`,
    });
  }

  const g = window.__landmarked.globe;
  g.widget.scene.screenSpaceCameraController.minimumZoomDistance = 1; // the reel sets its own heights
  g.closestAlt = () => 1;
}, { clue, title: TPL.title, photo, crop, regular: font(400), semi: font(600), W, H });
await page.evaluate(() => document.fonts.ready);

// ---------- layout ----------
// where: clue on top, title under the globe. who: title on top, clue at the bottom. Long
// clues get a smaller font. The globe sits in the band between title and clue: its
// canvas is made taller and moved so its centre is the band's centre (the camera always
// looks at the canvas centre), and the camera height sets its size.
const band = await page.evaluate(({ tName, H, SAFE_BOTTOM }) => {
  const $ = (s) => document.querySelector('#reel ' + s);
  const clue = $('.clue'), title = $('.title');
  if (tName === 'who') {
    title.style.top = '170px';
    clue.style.bottom = SAFE_BOTTOM + 'px';
    for (const fs of [50, 46, 42, 39]) { clue.style.fontSize = fs + 'px'; if (clue.offsetHeight <= 420) break; }
    return { top: title.getBoundingClientRect().bottom + 50, bottom: clue.getBoundingClientRect().top - 50 };
  }
  clue.style.top = '170px';
  for (const fs of [50, 46, 42, 39]) { clue.style.fontSize = fs + 'px'; if (clue.getBoundingClientRect().bottom <= 620) break; }
  const bottom = H - SAFE_BOTTOM - title.offsetHeight - 40;
  title.style.top = bottom + 40 + 'px';
  return { top: clue.getBoundingClientRect().bottom + 50, bottom };
}, { tName, H, SAFE_BOTTOM });
const cy = (band.top + band.bottom) / 2;
const radius = Math.min((band.bottom - band.top) / 2, 470);
const Hc = Math.round(H + 2 * Math.abs(cy - H / 2));
const canvasTop = Math.round(cy - Hc / 2);
await page.evaluate(({ top, h }) => {
  const el = document.getElementById('globe');
  el.style.setProperty('top', top + 'px', 'important');
  el.style.setProperty('height', h + 'px', 'important');
  window.__landmarked.globe.widget.resize();
}, { top: canvasTop, h: Hc });
const TAN = Math.tan(Math.PI / 6); // the camera sees 60° across the canvas height
// Height at which the whole globe's radius on screen is `radius` pixels.
const HOME = R_EARTH / Math.sin(Math.atan((radius * TAN) / (Hc / 2))) - R_EARTH;
// who: the pin's tip sits a little below the band's centre (the pin is drawn above its tip).
const PIN_Y = cy + 40;

// ---------- camera ----------
const ease = (u) => u * u * (3 - 2 * u);
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const clamp = (u) => Math.max(0, Math.min(1, u));
const logLerp = (a, z, u) => Math.exp(Math.log(a) + (Math.log(z) - Math.log(a)) * u);
// Hermite curve from p0 (speed m0) to p1 (speed m1), u in 0..1, speeds per whole segment.
const hermite = (p0, p1, m0, m1, u) =>
  (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * m0 + (-2 * u ** 3 + 3 * u ** 2) * p1 + (u ** 3 - u ** 2) * m1;
// Look a little south of the building near the ground so the pin sits at PIN_Y.
const shiftAt = (alt) => (((Hc / 2 - (PIN_Y - canvasTop)) / Hc) * 2 * TAN * alt) / DEG_M;

function camera(t) {
  if (tName === 'where') {
    // Always the same neutral spin (starting over Europe and Africa), so the globe gives
    // nothing away; it just keeps turning.
    const s = Math.max(0, t - TPL.closeup);
    return { lon: 30 + TPL.spin * s, lat: START_LAT, alt: HOME };
  }
  const lon0 = b.lon + TPL.swoopIn;
  let lon, lat, alt, k;
  if (t <= TPL.restAt) {
    const d = TPL.restAt, u = t / d;
    k = easeInOut(u);
    lon = hermite(lon0, b.lon, TPL.spin * d, 0, u);
    lat = START_LAT + (b.lat - START_LAT) * ease(u);
    alt = logLerp(HOME, TPL.closeAlt, k);
  } else if (t <= TPL.outAt) {
    k = 1; lon = b.lon; lat = b.lat; alt = TPL.closeAlt;
  } else {
    const d = TPL.total - TPL.outAt, u = (t - TPL.outAt) / d;
    k = 1 - easeInOut(u);
    lon = hermite(b.lon, lon0 - 360, 0, TPL.spin * d, u);
    lat = b.lat + (START_LAT - b.lat) * ease(u);
    alt = logLerp(TPL.closeAlt, HOME, easeInOut(u));
  }
  return { lon, lat: lat - shiftAt(alt) * k, alt };
}

function overlay(t) {
  if (tName === 'where') return { closeup: t < TPL.closeup, pin: 0, drop: 0, ring: 0 };
  const DROP = TPL.pinAt - TPL.restAt;
  const u = clamp((t - TPL.restAt) / DROP);
  // Drops from above with a small bounce, landing at pinAt; a ring pulses out; fades as it zooms out.
  const bounce = u < 0.75 ? easeOut(u / 0.75) : 1 - Math.sin(((u - 0.75) / 0.25) * Math.PI) * 0.06;
  return {
    closeup: false,
    pin: t > TPL.restAt ? 1 - clamp((t - TPL.outAt) / 0.25) : 0,
    drop: (1 - bounce) * -420,
    ring: clamp((t - (TPL.restAt + DROP * 0.75)) / 0.8),
  };
}

// ---------- frames ----------
const n = Math.round(TPL.total * FPS);
console.log(`${b.name}, ${tName}: ${clue.split(/\s+/).length}-word clue, ${TPL.total} s, ${n} frames`);
const t0 = Date.now();
const only = process.env.AT ? process.env.AT.split(',').map((x) => Math.min(n - 1, Math.round(Number(x) * FPS))) : null;
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  const t = i / FPS;
  await page.evaluate(({ cam, ov, lon, lat, top }) => {
    const scene = window.__landmarked.globe.widget.scene;
    const C3 = scene.camera.position.constructor;
    scene.camera.setView({ destination: C3.fromDegrees(cam.lon, cam.lat, cam.alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    // Hide the country-code labels (they load after the page starts).
    for (let i = 0; i < scene.primitives.length; i++) {
      const q = scene.primitives.get(i);
      if (q && typeof q.get === 'function' && q.length > 0 && typeof q.get(0)?.text === 'string') q.show = false;
    }
    scene.requestRender();
    scene.render();
    const p = scene.cartesianToCanvasCoordinates(C3.fromDegrees(lon, lat, 0));
    const x = p ? p.x : -999, y = p ? p.y + top : -999;
    const $ = (s) => document.querySelector('#reel ' + s);
    $('.closeup').style.display = ov.closeup ? 'block' : 'none';
    $('.pin').style.opacity = ov.pin;
    $('.pin').style.transform = `translate(${x}px, ${y + ov.drop}px)`;
    $('.ring').style.transform = `translate(${x}px, ${y}px) scale(${0.3 + ov.ring * 1.6})`;
    $('.ring').style.opacity = ov.ring > 0 && ov.ring < 1 ? 1 - ov.ring : 0;
  }, { cam: camera(t), ov: overlay(t), lon: b.lon, lat: b.lat, top: canvasTop });
  // Wait for this view's tiles, then draw once more and capture.
  await page.waitForFunction(() => {
    const s = window.__landmarked.globe.widget.scene;
    s.requestRender(); s.render();
    return s.globe.tilesLoaded;
  }, { timeout: 60_000, polling: 50 }).catch(() => console.warn(`frame ${i}: tiles still loading`));
  await page.screenshot({ path: `${frames}${String(i).padStart(4, '0')}.png` });
  if (i % 60 === 0) console.log(`  ${i}/${n} frames, ${Math.round((Date.now() - t0) / 1000)} s`);
}
await browser.close();
if (only) { console.log(`frames in social/reels/.frames-${id}/`); process.exit(0); }

const base = `social/reels/${id}-${tName}`;
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}%04d.png`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path(`${base}.mp4`)]);
rmSync(frames, { recursive: true, force: true });

// ---------- caption ----------
// Hook line, the question with the difficulty square (as on the carousels), the play
// line, the four general hashtags, and the photo credit when a photo is shown.
const hook = process.env.HOOK ?? post?.line;
if (!hook) console.warn('no HOOK: the caption starts with a placeholder; write one surprising fact from the blurb');
const square = { easy: '🟩', medium: '🟨', hard: '🟥' }[b.tier] ?? '';
let credit = '';
if (tName === 'where') {
  const c = read('public/photos/credits.json')[id];
  const fromPost = Object.values(read('data/social-captions.json')).find((x) => x.id === id)?.text.split('\n').find((l) => l.startsWith('📷'));
  if (fromPost) credit = fromPost.includes('cropped') ? fromPost : fromPost.replace(' · Wikimedia Commons', ' · cropped · Wikimedia Commons');
  else if (c) {
    const artist = c.artist.replace(/^No machine-readable author provided\.\s*(.+?) assumed.*$/, '$1').trim();
    credit = /^(cc0|pd|public domain)/i.test(c.license) ? '📷 Wikimedia Commons' : `📷 ${artist} · ${c.license} · cropped · Wikimedia Commons`;
  }
}
const caption = [
  hook ?? '[HOOK: one surprising fact from the blurb, 10–20 words, no names]', '',
  `${TPL.question} ${square}`.trim(),
  'Play at landmarked.land (link in bio)', '',
  '#architecture #geography #dailypuzzle #guessthebuilding',
  ...(credit ? ['', credit] : []),
].join('\n');
const notes = [
  '--- notes, not part of the caption ---',
  tName === 'who' ? `The pin lands at ${TPL.pinAt} s: start the song so its beat drop hits there.` : 'Pick calm, neutral music: a song that matches the place would give it away.',
  'No location tag: Instagram shows it above the video, which gives the answer away.',
].join('\n');
writeFileSync(path(`${base}.txt`), caption + '\n\n' + notes + '\n');
console.log(`wrote ${base}.mp4 and .txt`);
