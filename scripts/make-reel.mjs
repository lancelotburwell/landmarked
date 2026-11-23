// Renders an Instagram reel (1080×1920, 30 fps MP4) for one day's sneak-peek building,
// posted the day after as its answer: the game's globe spins with the clue on screen,
// turns to the region and hovers for a moment (time to guess), dives to the spot, a
// gold pin lands at exactly PIN_AT seconds (so a beat drop can be lined up in
// Instagram), the photo card slides up with the name and architect, and it all pulls
// back out to the opening frame, so the reel loops seamlessly. No music (added in
// Instagram when posting).
//
// Every frame is set up and captured one by one (camera placed, tiles loaded, then a
// screenshot), so the video is smooth however slowly the globe draws.
//
//   npm run build && npx vite preview --port 4173, then
//   node scripts/make-reel.mjs <date> [http://localhost:4173/]
//   GPU=1 node scripts/make-reel.mjs <date>             draw with the graphics card (faster, if it works)
//   AT=2,9.5,12,15 node scripts/make-reel.mjs <date>   only those moments (s), as PNGs, for a quick look
//
// <date> is a day in data/social.json; the reel shows that post's building with the
// clue it had that day. Writes social/reels/<post date>-<id>.mp4 (gitignored), named by
// the day it should be posted: the day after the carousel. Uses the large
// photo from social/src/<id>.jpg when present (scripts/social-photos.mjs), otherwise
// the game's 640 px one.
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

const [date, url = 'http://localhost:4173/'] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) { console.error('usage: node scripts/make-reel.mjs <YYYY-MM-DD> [url]'); process.exit(1); }
const post = read('data/social.json').find((s) => s.date === date);
if (!post) { console.error(`${date} has no Instagram post in data/social.json`); process.exit(1); }
const day = read('data/schedule.json').find((d) => d.date === date);
const b = read('data/buildings.json').find((x) => x.id === post.id);
const slot = day.ids.indexOf(b.id);
const clue = b.clues[day.clues?.[slot] ?? 0] ?? b.clues[0];

const big = `social/src/${b.id}.jpg`;
const photoFile = existsSync(new URL(big, root)) ? big : `public/photos/${b.id}.jpg`;
const photo = existsSync(new URL(photoFile, root)) ? readFileSync(new URL(photoFile, root)).toString('base64') : null;
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');

// ---------- timeline (seconds) ----------
// Fixed, so every reel has the same rhythm and the pin always lands at PIN_AT.
const FPS = 30;
const words = clue.split(/\s+/).length;
const SPIN_END = 4.0;   // globe spins, clue on screen (it stays on screen throughout)
const TURN_END = 5.6;   // spin slows and turns to the region
const HOVER_END = 6.3;  // hovers over the region: a moment to guess
const DIVE_END = 7.4;   // dives to the spot
const PIN_AT = 8.0;     // the pin lands
const CARD_END = 8.5;   // card slides up
const OUT_AT = 10.8;    // hold on the card, then pull back out to the opening frame
const TOTAL = 11.8;     // = the first frame again, so it loops
const SPIN = -14;       // camera longitude per second: the globe turns eastward, like the Earth
const START_LAT = 18;
const HOVER_ALT = 7_000_000;
// Closest height: where one video pixel covers about 600 m (Blue Marble's own pixel
// size at the equator) would be ~1,000 km; a little closer still reads as sharp on a phone.
const CLOSE_ALT = 800_000;
const PIN_Y = 690; // where the pin lands, from the top

const next = new Date(Date.parse(date + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
const W = 1080, H = 1920;
const frames = path(`social/reels/.frames-${date}/`);
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

await page.evaluate(({ clue, name, architect, photo, regular, semi }) => {
  // Only the globe, full screen, with our overlay on top.
  const css = document.createElement('style');
  css.textContent = `
    @font-face { font-family: ReelPlex; font-weight: 400; src: url(data:font/woff2;base64,${regular}) format('woff2'); }
    @font-face { font-family: ReelPlex; font-weight: 600; src: url(data:font/woff2;base64,${semi}) format('woff2'); }
    body > * { visibility: hidden; }
    #globe { visibility: visible; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 10; }
    #globe .pins { display: none; }
    #reel { visibility: visible; position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: ReelPlex, monospace; color: #ece6da; }
    #reel .clue { position: absolute; left: 90px; right: 90px; top: 170px; text-align: center; font-size: 50px; line-height: 1.38; font-weight: 600;
      text-shadow: 0 2px 6px rgb(0 0 0 / 0.9), 0 0 28px rgb(0 0 0 / 0.75); }
    #reel .pin { position: absolute; left: 0; top: 0; width: 84px; height: 112px; margin: -112px 0 0 -42px; opacity: 0; filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.6)); }
    #reel .ring { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; border: 5px solid #e3b261; border-radius: 50%; opacity: 0; }
    #reel .card { position: absolute; left: 60px; right: 60px; bottom: 330px; background: #16191c; border: 2px solid #2b3036; border-radius: 32px; overflow: hidden;
      transform: translateY(1400px); box-shadow: 0 20px 60px rgb(0 0 0 / 0.6); }
    #reel .card .ph { position: relative; height: 540px; overflow: hidden; background: #0e1012; }
    #reel .card .ph i { position: absolute; inset: -40px; background-size: cover; background-position: center; filter: blur(30px) brightness(0.6); }
    #reel .card .ph b { position: absolute; inset: 0; background-size: contain; background-position: center; background-repeat: no-repeat; }
    #reel .card .tx { padding: 34px 44px 40px; }
    #reel .card .nm { font-size: 54px; font-weight: 600; line-height: 1.15; }
    #reel .card .ar { margin-top: 12px; font-size: 36px; color: #99938a; }
  `;
  document.head.append(css);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reel = document.createElement('div');
  reel.id = 'reel';
  const img = photo ? `url(data:image/jpeg;base64,${photo})` : 'none';
  reel.innerHTML = `
    <div class="clue">${esc(clue)}</div>
    <div class="ring"></div>
    <svg class="pin" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.8 1 11.8 1 20.2 12 31 12 31s11-10.8 11-19.2C23 5.8 18.1 1 12 1z" fill="#e3b261" stroke="#1a1408" stroke-width="1"/><circle cx="12" cy="11.6" r="4.2" fill="#1a1408"/></svg>
    <div class="card">${photo ? `<div class="ph"><i style="background-image:${img}"></i><b style="background-image:${img}"></b></div>` : ''}
      <div class="tx"><div class="nm">${esc(name)}</div><div class="ar">${esc(architect)}</div></div></div>`;
  document.body.append(reel);
  document.getElementById('intro').hidden = true;

  const g = window.__landmarked.globe;
  const scene = g.widget.scene;
  // Lift the zoom limit (the reel sets its own) and hide the country-code labels.
  scene.screenSpaceCameraController.minimumZoomDistance = 1;
  g.closestAlt = () => 1;
  for (let i = 0; i < scene.primitives.length; i++) {
    const p = scene.primitives.get(i);
    if (p && typeof p.add === 'function' && 'totalGlyphCount' in p) p.show = false;
  }
}, { clue, name: b.name, architect: b.architect, photo, regular: font(400), semi: font(600) });
await page.evaluate(() => document.fonts.ready);

// Home height: the whole globe fits the width, with a margin.
// A bit smaller than in the game, so the clue sits clear above it.
const HOME = await page.evaluate(() => window.__landmarked.globe.homeAlt()) * 1.18;

const ease = (u) => u * u * (3 - 2 * u);
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const clamp = (u) => Math.max(0, Math.min(1, u));
const logLerp = (a, b, u) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
// Hermite curve from p0 (speed m0) to p1 (speed m1), u in 0..1, speeds per whole segment.
const hermite = (p0, p1, m0, m1, u) =>
  (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * m0 + (-2 * u ** 3 + 3 * u ** 2) * p1 + (u ** 3 - u ** 2) * m1;
// Where the spin starts, so that it flows into the turn without stopping (the turn
// covers about SPIN·duration/2 more degrees while it slows down).
const lon0 = b.lon - SPIN * (SPIN_END + (TURN_END - SPIN_END) / 2);
// Look a little south of the building near the ground, so its pin sits at PIN_Y,
// between the clue and the card (the camera looks straight down, 60° across the height).
const shiftAt = (alt) => (((H / 2 - PIN_Y) / H) * 2 * Math.tan(Math.PI / 6) * alt) / 111_320;
const END = { lon: b.lon, lat: b.lat - shiftAt(CLOSE_ALT), alt: CLOSE_ALT };

function camera(t) {
  if (t <= SPIN_END) return { lon: lon0 + SPIN * t, lat: START_LAT, alt: HOME };
  if (t <= TURN_END) {
    const d = TURN_END - SPIN_END, u = (t - SPIN_END) / d;
    return { lon: hermite(lon0 + SPIN * SPIN_END, b.lon, SPIN * d, 0, u), lat: START_LAT + (b.lat - START_LAT) * ease(u), alt: logLerp(HOME, HOVER_ALT, easeOut(u)) };
  }
  if (t <= HOVER_END) {
    // Nearly still, drifting in a touch so it doesn't look frozen.
    const u = (t - TURN_END) / (HOVER_END - TURN_END);
    return { lon: b.lon, lat: b.lat, alt: logLerp(HOVER_ALT, HOVER_ALT * 0.9, u) };
  }
  if (t <= DIVE_END) {
    const a = easeInOut((t - HOVER_END) / (DIVE_END - HOVER_END));
    const alt = logLerp(HOVER_ALT * 0.9, CLOSE_ALT, a);
    return { lon: b.lon, lat: b.lat - shiftAt(alt) * a, alt };
  }
  if (t <= OUT_AT) return END;
  // Pull back out to the opening frame, arriving at the spin's speed so the loop is seamless.
  const d = TOTAL - OUT_AT, u = (t - OUT_AT) / d;
  return {
    lon: hermite(END.lon, lon0, 0, SPIN * d, u),
    lat: END.lat + (START_LAT - END.lat) * easeInOut(u),
    alt: logLerp(CLOSE_ALT, HOME, easeInOut(u)),
  };
}

function overlay(t) {
  const DROP = PIN_AT - DIVE_END;
  const pinU = clamp((t - DIVE_END) / DROP);
  // Pin: drops from above with a small bounce, landing at PIN_AT; a ring pulses out.
  const bounce = pinU < 0.75 ? easeOut(pinU / 0.75) : 1 - Math.sin(((pinU - 0.75) / 0.25) * Math.PI) * 0.06;
  const out = clamp((t - OUT_AT) / 0.45);
  return {
    pinOpacity: t > DIVE_END ? 1 - clamp((t - OUT_AT) / 0.25) : 0,
    pinDrop: (1 - bounce) * -420,
    ringU: clamp((t - (DIVE_END + DROP * 0.75)) / 0.8),
    cardY: t < OUT_AT ? (1 - easeOut(clamp((t - PIN_AT) / (CARD_END - PIN_AT)))) * 1400 : out ** 2 * 1400,
  };
}

const n = Math.round(TOTAL * FPS);
console.log(`${b.name} (post on ${next}): ${words}-word clue, ${TOTAL.toFixed(1)} s, ${n} frames`);
const t0 = Date.now();
const only = process.env.AT ? process.env.AT.split(',').map((x) => Math.min(n - 1, Math.round(Number(x) * FPS))) : null;
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  const t = i / FPS;
  await page.evaluate(({ cam, ov, lon, lat }) => {
    const scene = window.__landmarked.globe.widget.scene;
    const C3 = scene.camera.position.constructor;
    scene.camera.setView({ destination: C3.fromDegrees(cam.lon, cam.lat, cam.alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    for (let i = 0; i < scene.primitives.length; i++) {
      const q = scene.primitives.get(i);
      if (q && typeof q.get === 'function' && q.length > 0 && typeof q.get(0)?.text === 'string') q.show = false;
    }
    scene.requestRender();
    scene.render();
    const p = scene.cartesianToCanvasCoordinates(C3.fromDegrees(lon, lat, 0));
    const x = p ? p.x : -999, y = p ? p.y : -999;
    const pin = document.querySelector('#reel .pin'), ring = document.querySelector('#reel .ring');
    pin.style.opacity = ov.pinOpacity;
    pin.style.transform = `translate(${x}px, ${y + ov.pinDrop}px)`;
    ring.style.transform = `translate(${x}px, ${y}px) scale(${0.3 + ov.ringU * 1.6})`;
    ring.style.opacity = ov.ringU > 0 && ov.ringU < 1 ? 1 - ov.ringU : 0;
    document.querySelector('#reel .card').style.transform = `translateY(${ov.cardY}px)`;
  }, { cam: camera(t), ov: overlay(t), lon: b.lon, lat: b.lat });
  // Wait for this view's tiles, then draw once more and capture.
  await page.waitForFunction(() => {
    const s = window.__landmarked.globe.widget.scene;
    s.requestRender(); s.render();
    return s.globe.tilesLoaded;
  }, { timeout: 60_000, polling: 50 }).catch(() => console.warn(`frame ${i}: tiles still loading`));
  await page.screenshot({ path: `${frames}${String(i).padStart(4, '0')}.png` });
  if (i % 30 === 0) console.log(`  ${i}/${n} frames, ${Math.round((Date.now() - t0) / 1000)} s`);
}
await browser.close();
if (only) { console.log(`frames in social/reels/.frames-${date}/`); process.exit(0); }

const out = path(`social/reels/${next}-${b.id}.mp4`);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}%04d.png`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
rmSync(frames, { recursive: true, force: true });
console.log(`wrote social/reels/${next}-${b.id}.mp4`);
