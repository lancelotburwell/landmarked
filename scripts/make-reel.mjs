// Renders an Instagram reel (1080×1920, 30 fps MP4) for one day's sneak-peek building,
// posted the day after as its answer: the game's globe spins with the clue on screen,
// turns and zooms down to the spot, a gold pin drops, and the photo card slides up
// with the name and architect. No music (added in Instagram when posting).
//
// Every frame is set up and captured one by one (camera placed, tiles loaded, then a
// screenshot), so the video is smooth however slowly the globe draws.
//
//   npm run build && npx vite preview --port 4173, then
//   node scripts/make-reel.mjs <date> [http://localhost:4173/]
//   AT=2,9.5,12,15 node scripts/make-reel.mjs <date>   only those moments (s), as PNGs, for a quick look
//
// <date> is a day in data/social.json; the reel shows that post's building with the
// clue it had that day. Writes social/reels/<date>.mp4 (gitignored). Uses the large
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
const FPS = 30;
const words = clue.split(/\s+/).length;
const T_SPIN = Math.max(5, Math.min(9, 1.5 + words * 0.25)); // time to read the clue while it spins
const T_ZOOM = 3.2;   // turn and dive to the spot
const T_PIN = 0.6;    // pin drops
const T_CARD = 0.6;   // card slides up
const T_HOLD = 3.2;   // hold on the card
const TOTAL = T_SPIN + T_ZOOM + T_PIN + T_CARD + T_HOLD;
const SPIN = -14;     // camera longitude per second: the globe turns eastward, like the Earth
const START_LAT = 18;
// Closest height: where one video pixel covers about 600 m (Blue Marble's own pixel
// size at the equator) would be ~1,000 km; a little closer still reads as sharp on a phone.
const CLOSE_ALT = 800_000;
const PIN_Y = 690; // where the pin lands, from the top

const W = 1080, H = 1920;
const frames = path(`social/reels/.frames-${date}/`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
// Where the spin starts, so that it flows straight into the zoom without stopping:
// the zoom covers about SPIN·T_ZOOM/2 degrees more while it slows down.
const lon0 = b.lon - SPIN * (T_SPIN + T_ZOOM / 2);

function camera(t) {
  if (t <= T_SPIN) return { lon: lon0 + SPIN * t, lat: START_LAT, alt: HOME };
  const u = Math.min(1, (t - T_SPIN) / T_ZOOM);
  // Longitude: Hermite curve that starts at the spin's speed and comes to rest on the building.
  const p0 = lon0 + SPIN * T_SPIN, p1 = b.lon, m0 = SPIN * T_ZOOM;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2;
  const lon = h00 * p0 + h10 * m0 + h01 * p1;
  const lat = START_LAT + (b.lat - START_LAT) * ease(u);
  // Height: start the dive a little after the turn, in log space so it feels even.
  const a = easeInOut(Math.max(0, (u - 0.15) / 0.85));
  const alt = Math.exp(Math.log(HOME) + (Math.log(CLOSE_ALT) - Math.log(HOME)) * a);
  // Look a little south of the building as we arrive, so its pin ends up at PIN_Y,
  // between the clue and the card (the camera looks straight down, 60° across the height).
  const shift = (((H / 2 - PIN_Y) / H) * 2 * Math.tan(Math.PI / 6) * alt) / 111_320;
  return { lon, lat: lat - shift * a, alt };
}

function overlay(t) {
  const tp = t - T_SPIN - T_ZOOM;                 // since the zoom ended
  const pinU = Math.max(0, Math.min(1, tp / T_PIN));
  const cardU = Math.max(0, Math.min(1, (tp - T_PIN) / T_CARD));
  // Pin: drops from above with a small bounce; a ring pulses out when it lands.
  const bounce = pinU < 0.7 ? easeOut(pinU / 0.7) : 1 - Math.sin(((pinU - 0.7) / 0.3) * Math.PI) * 0.06;
  return {
    pinOpacity: tp > 0 ? 1 : 0,
    pinDrop: (1 - bounce) * -420,
    ringU: Math.max(0, Math.min(1, (tp - T_PIN * 0.7) / 0.8)),
    cardY: (1 - easeOut(cardU)) * 1400,
  };
}

const n = Math.round(TOTAL * FPS);
console.log(`${b.name}: ${words}-word clue, ${TOTAL.toFixed(1)} s, ${n} frames`);
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

const out = path(`social/reels/${date}.mp4`);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}%04d.png`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
rmSync(frames, { recursive: true, force: true });
console.log(`wrote social/reels/${date}.mp4`);
