// Renders an Instagram reel (1080×1920, 30 fps MP4) in one of the two templates the
// user chose on 2026-11-23, plus its caption. Neither template shows the answer: the
// question is for the comments. No music (the user adds it in Instagram).
//
//   where  "Where am I?": the clue above and a big gold "Where am I?" below, on screen
//          from the first frame. It opens on a close-up crop of the building, slowly
//          pushing in; at 2.2 s the photo shrinks into a circle that lands exactly on the
//          globe and blends into it (user, 2026-11-23: no hard cut); the globe just spins
//          (no zoom, no pin); from 10 s the same in reverse, so the last frame is the first.
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
//   OPENER="…"    the hook on screen for the first 1.6 s, 5–8 words (default per template)
//   DECOYS="x,y"  the two wrong options (cities for where, buildings for who); default:
//                 picked from the pool, see "A, B, C" below. The answer's letter is seeded.
//   CLUE=n        which of the building's clues (default 0, the first)
//   AT=1,3,6.6    render only those moments (s), as PNGs in social/reels/.frames-<id>/
//
// Writes social/reels/<id>-<template>.mp4 and .txt (the caption; gitignored). Uses the
// large photo from social/src/<id>.jpg (scripts/social-photos.mjs <id>).
// Use easy buildings with good clues, and only post a "who" reel after that building's
// day has been played: the pin gives the location away.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

// ---------- the two templates ----------
// Both open on a short hook (OPENER) where the clue goes; the clue then comes in a line
// at a time, and at the end the hook comes back so the loop is seamless. Three options
// (A, B, C: cities for "where", buildings for "who") sit under the title the whole time,
// so commenting takes one letter (user, 2026-11-24). The answer is still never shown.
const TEMPLATES = {
  where: { title: 'Where am I?', opener: 'Can you place this building?', question: 'Where am I? Comment A, B or C 👇', total: 11, spin: -12,
    shrinkAt: 2.2,  // the close-up starts shrinking into the globe
    globeAt: 3.4,   // ... and has become the globe
    growAt: 10.0 }, // the globe starts turning back into the close-up (done at total = frame 0)
  who: { title: 'Who am I?', opener: 'Name this building from one clue', question: 'Who am I? Comment A, B or C 👇', total: 11.8, spin: -50,
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
const opener = process.env.OPENER ?? TPL.opener;

// ---------- A, B, C ----------
// Two decoys from the pool, plausible but not the answer: for "where", other cities
// 300–2,500 km away; for "who", the nearest other buildings (the pin shows the region, so
// far-away decoys would be no contest). Seeded by the id, so a rerun gives the same three.
// DECOYS="x,y" sets them by hand.
const km = (a, z) => {
  const r = Math.PI / 180, h = Math.sin(((z.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(z.lat * r) * Math.sin(((z.lon - a.lon) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
};
let seed = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32);
const answer = tName === 'where' ? b.city : b.name;
let decoys = process.env.DECOYS?.split(',').map((s) => s.trim());
if (!decoys) {
  const pool = read('data/buildings.json').filter((x) => !x.retired && x.id !== id);
  let cands;
  if (tName === 'where') {
    const cities = new Map();
    for (const x of pool) if (x.city !== b.city && !cities.has(x.city)) cities.set(x.city, km(b, x));
    const all = [...cities].sort((p, q) => p[1] - q[1]);
    cands = all.filter(([, d]) => d >= 300 && d <= 2500).map(([c]) => c);
    if (cands.length < 2) cands = all.filter(([, d]) => d >= 300).slice(0, 4).map(([c]) => c);
  } else {
    cands = pool.map((x) => [x.name, km(b, x)]).sort((p, q) => p[1] - q[1]).slice(0, 5).map(([n]) => n);
  }
  decoys = [];
  while (decoys.length < 2 && cands.length) decoys.push(cands.splice(Math.floor(rand() * cands.length), 1)[0]);
}
const options = [...decoys];
options.splice(Math.floor(rand() * 3), 0, answer);
const LETTERS = ['A', 'B', 'C'];
const answerLetter = LETTERS[options.indexOf(answer)];

if (tName === 'where' && !crop) { console.error(`${id}: give CROP=x,y,width for the close-up (see the header)`); process.exit(1); }

// A photo picked for the reel (FILE=… scripts/social-photos.mjs <id>) wins over the game's.
const reelPhoto = existsSync(new URL(`social/src/${id}-reel.jpg`, root));
const bigPhoto = `social/src/${id}${reelPhoto ? '-reel' : ''}.jpg`;
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
await page.evaluate(async ({ clue, title, opener, options, photo, crop, regular, semi, W, H }) => {
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
    #reel .opener { position: absolute; left: 70px; right: 70px; text-align: center; font-size: 68px; line-height: 1.25; font-weight: 600; z-index: 3; }
    #reel .options { position: absolute; left: 40px; right: 40px; display: flex; flex-wrap: wrap; justify-content: center; gap: 18px 22px; z-index: 3; }
    #reel .opt { font-size: 38px; font-weight: 600; padding: 12px 30px; border-radius: 999px; background: rgb(12 14 16 / 0.82); border: 3px solid rgb(227 178 97 / 0.85); white-space: nowrap; }
    #reel .opt b { color: #e3b261; margin-right: 14px; }
    #reel .title { position: absolute; left: 60px; right: 60px; text-align: center; color: #e3b261; font-size: 84px; font-weight: 600; z-index: 3; }
    #reel .pin { position: absolute; left: 0; top: 0; width: 84px; height: 112px; margin: -112px 0 0 -42px; opacity: 0; filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.6)); z-index: 2; }
    #reel .ring { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; border: 5px solid #e3b261; border-radius: 50%; opacity: 0; z-index: 2; }
    #reel .closeup-wrap { position: absolute; inset: 0; z-index: 1; display: none; overflow: hidden; }
    #reel .closeup { position: absolute; inset: 0; background-color: #0e1012; background-repeat: no-repeat; background-size: 100% 100%; transform-origin: 50% 50%; }
  `;
  document.head.append(css);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reel = document.createElement('div');
  reel.id = 'reel';
  reel.innerHTML = `
    <div class="closeup-wrap"><div class="closeup"></div></div>
    <div class="title shadow"><span>${esc(title)}</span></div>
    <div class="clue shadow">${clue.split(/\s+/).map((w) => `<span>${esc(w)}</span>`).join(' ')}</div>
    <div class="opener shadow">${esc(opener)}</div>
    <div class="options">${options.map((o, i) => `<span class="opt"><b>${'ABC'[i]}</b>${esc(o)}</span>`).join('')}</div>
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
    // Drawn into a canvas once the title's place is known (see the layout below).
    window.__closeup = { im, x0, y0, rw, rh };
  }

  const g = window.__landmarked.globe;
  g.widget.scene.screenSpaceCameraController.minimumZoomDistance = 1; // the reel sets its own heights
  g.closestAlt = () => 1;
}, { clue, title: TPL.title, opener, options, photo, crop, regular: font(400), semi: font(600), W, H });
await page.evaluate(() => document.fonts.ready);

// ---------- layout ----------
// where: clue on top, title under the globe. who: title on top, clue at the bottom. Long
// clues get a smaller font. The globe sits in the band between title and clue: its
// canvas is made taller and moved so its centre is the band's centre (the camera always
// looks at the canvas centre), and the camera height sets its size.
const band = await page.evaluate(({ tName, W, H, SAFE_BOTTOM }) => {
  const $ = (s) => document.querySelector('#reel ' + s);
  const clue = $('.clue'), title = $('.title'), opener = $('.opener'), opts = $('.options');
  opts.style.bottom = SAFE_BOTTOM + 'px';
  const optH = opts.offsetHeight;
  // The clue's words, grouped into the lines they wrap to, so they can come in a line at a time.
  const lines = () => {
    const out = [];
    let top = null;
    for (const w of clue.querySelectorAll('span')) {
      if (w.offsetTop !== top) { out.push([]); top = w.offsetTop; }
      out.at(-1).push(w);
    }
    window.__lines = out;
  };
  if (tName === 'who') {
    // The zoom ends over land (often bright desert), so the text gets dark panels; flat
    // colours render fine in headless Chrome, unlike gradients and blurs.
    const panel = 'background: rgb(10 12 14 / 0.66); border-radius: 26px;';
    title.querySelector('span').style.cssText = panel + 'padding: 4px 34px;';
    clue.style.cssText += panel + 'padding: 20px 30px; left: 60px; right: 60px;';
    title.style.top = '170px';
    clue.style.bottom = SAFE_BOTTOM + optH + 36 + 'px';
    for (const fs of [50, 46, 42, 39]) { clue.style.fontSize = fs + 'px'; if (clue.offsetHeight <= 380) break; }
    // The hook stands where the clue's middle will be.
    const r = clue.getBoundingClientRect();
    opener.style.top = r.top + r.height / 2 - opener.offsetHeight / 2 + 'px';
    lines();
    return { top: title.getBoundingClientRect().bottom + 50, bottom: r.top - 50 };
  }
  clue.style.top = '170px';
  for (const fs of [50, 46, 42, 39]) { clue.style.fontSize = fs + 'px'; if (clue.getBoundingClientRect().bottom <= 620) break; }
  opener.style.top = '200px';
  lines();
  const bottom = H - SAFE_BOTTOM - optH - 30 - title.offsetHeight - 40;
  title.style.top = bottom + 40 + 'px';
  // The close-up, drawn into a canvas with the shading baked in (CSS gradients, blurs and
  // shadows don't reliably show in headless Chrome on the graphics card): a dark fade
  // behind the clue at the top and a soft dark glow behind the gold title, so both
  // read on any photo.
  const c = window.__closeup;
  if (c) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true }); // CPU canvas: the GPU one drops gradients here
    g.drawImage(c.im, c.x0, c.y0, c.rw, c.rh, 0, 0, W, H);
    const top = g.createLinearGradient(0, 0, 0, clue.getBoundingClientRect().bottom + 160);
    top.addColorStop(0, 'rgba(0,0,0,0.6)'); top.addColorStop(0.7, 'rgba(0,0,0,0.35)'); top.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = top; g.fillRect(0, 0, W, H);
    const ty = bottom + 40 + title.offsetHeight / 2;
    g.save();
    g.filter = 'blur(46px)';
    g.fillStyle = 'rgba(0,0,0,0.78)';
    g.beginPath(); g.ellipse(W / 2, ty, 430, 120, 0, 0, Math.PI * 2); g.fill();
    g.restore();
    $('.closeup').style.backgroundImage = `url(${cv.toDataURL('image/jpeg', 0.94)})`;
  }
  return { top: clue.getBoundingClientRect().bottom + 50, bottom };
}, { tName, W, H, SAFE_BOTTOM });
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
    return { lon: 30 + TPL.spin * t, lat: START_LAT, alt: HOME };
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

// The text: the hook alone until HOOK_END, then the clue a line at a time; in the last
// half second the clue fades and the hook returns, so the last frame is the first.
const HOOK_END = 1.6, LINE_GAP = 0.55, FADE = 0.25;
function text(t) {
  const back = clamp((t - (TPL.total - 0.5)) / 0.4);
  return {
    opener: Math.max(1 - clamp((t - (HOOK_END - FADE)) / FADE), back),
    line: (i) => clamp((t - HOOK_END - i * LINE_GAP) / FADE) * (1 - back),
  };
}

function overlay(t) {
  if (tName === 'where') {
    // Full screen (a circle bigger than the screen's diagonal) → the globe's circle, and back.
    const FULL = Math.hypot(W, H) / 2 + 40;
    let u = 0, fade = 1, scale;
    if (t < TPL.shrinkAt) { u = 0; scale = 1 + 0.05 * (t / TPL.shrinkAt); }   // slow push-in
    else if (t < TPL.globeAt) {
      const k = (t - TPL.shrinkAt) / (TPL.globeAt - TPL.shrinkAt);
      u = easeInOut(k); scale = 1.05 - 0.15 * u;
      fade = 1 - clamp((k - 0.72) / 0.28);                                      // blends into the globe at the end
    } else if (t < TPL.growAt) { u = 1; fade = 0; scale = 0.9; }
    else {
      const k = (t - TPL.growAt) / (TPL.total - TPL.growAt);
      u = 1 - easeInOut(k); scale = 0.9 + 0.1 * (1 - u);
      fade = clamp(k / 0.28);                                                   // the globe blends back into the photo first
    }
    return { closeup: fade > 0, r: FULL + (radius - FULL) * u, cy: H / 2 + (cy - H / 2) * u, fade, scale, pin: 0, drop: 0, ring: 0 };
  }
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
console.log(`options: ${options.map((o, k) => `${LETTERS[k]} ${o}`).join(' · ')} (answer ${answerLetter})`);
const t0 = Date.now();
const only = process.env.AT ? process.env.AT.split(',').map((x) => Math.min(n - 1, Math.round(Number(x) * FPS))) : null;
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  const t = i / FPS;
  const tx = text(t);
  const lineOp = Array.from({ length: 12 }, (_, k) => tx.line(k));
  await page.evaluate(({ opener, lineOp }) => {
    document.querySelector('#reel .opener').style.opacity = opener;
    window.__lines.forEach((ws, k) => ws.forEach((w) => { w.style.opacity = lineOp[Math.min(k, 11)]; }));
  }, { opener: tx.opener, lineOp });
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
    const wrap = $('.closeup-wrap');
    wrap.style.display = ov.closeup ? 'block' : 'none';
    if (ov.closeup) {
      wrap.style.clipPath = `circle(${ov.r}px at 50% ${ov.cy}px)`;
      wrap.style.opacity = ov.fade;
      $('.closeup').style.transform = `scale(${ov.scale})`;
    }
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
  if (reelPhoto) {
    const r = read(`social/src/${id}-reel.json`);
    credit = /^(cc0|pd|public domain)/i.test(r.license) ? '📷 Wikimedia Commons' : `📷 ${r.artist} · ${r.license} · cropped · Wikimedia Commons`;
  } else if (fromPost) credit = fromPost.includes('cropped') ? fromPost : fromPost.replace(' · Wikimedia Commons', ' · cropped · Wikimedia Commons');
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
  `On screen: ${options.map((o, k) => `${LETTERS[k]} ${o}`).join(' · ')}. Answer: ${answerLetter}. Reply to guesses without giving it away ("warmer!", "right continent").`,
  tName === 'who' ? `The pin lands at ${TPL.pinAt} s: start the song so its beat drop hits there.` : 'Pick calm, neutral music: a song that matches the place would give it away.',
  'No location tag: Instagram shows it above the video, which gives the answer away.',
].join('\n');
writeFileSync(path(`${base}.txt`), caption + '\n\n' + notes + '\n');
console.log(`wrote ${base}.mp4 and .txt`);

// A copy for the phone (user, 2026-11-24): into a synced folder, by default Google Drive's
// "Landmarked reels" when this PC has it; REELS_TO=<folder> to change, REELS_TO= to skip.
const to = process.env.REELS_TO ?? (existsSync('G:/My Drive') ? 'G:/My Drive/Landmarked reels' : '');
if (to) {
  mkdirSync(to, { recursive: true });
  for (const ext of ['mp4', 'txt']) copyFileSync(path(`${base}.${ext}`), `${to}/${id}-${tName}.${ext}`);
  console.log(`copied to ${to}`);
}
