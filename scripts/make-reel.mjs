// Renders an Instagram reel (1080×1920, 30 fps MP4) for one day's sneak-peek building,
// posted the day after as its answer. The globe spins with the clue on screen as plain
// text, turns to the region and dives to the spot, a gold pin lands, and the building
// is revealed. No music (added in Instagram when posting).
//
// Every frame is set up and captured one by one (camera placed, tiles loaded, then a
// screenshot), so the video is smooth however slowly the globe draws.
//
//   npm run build && npx vite preview --port 4173, then
//   GPU=1 node scripts/make-reel.mjs <date> [format] [url]
//   AT=2,6,8 ...   only those moments (s), as PNGs in social/reels/.frames-<date>/, for a quick look
//   GPU=1          draw with the graphics card (much faster; without it, software ~8 min a reel)
//
// <date> is a day in data/social.json; the reel shows that post's building with the
// clue it had that day. Writes social/reels/<post date>-<id>-<format>.mp4 (gitignored),
// named by the day it should be posted: the day after the carousel. Uses the large
// photo from social/src/<id>.jpg when present (scripts/social-photos.mjs).
//
// Formats (FORMATS below), to compare which works best (2026-11-23):
//   classic    spin, turn, short hover (time to guess), dive, pin at 8.0 s, card slides up, loops
//   quick      the same in 7.8 s: faster spin, no hover, pin at 4.5 s
//   bigclue    the clue big in the middle over the spinning globe, moving to the top for the dive
//   fullphoto  after the pin, the photo fills the whole screen with the name over it
//   cinematic  the camera tilts towards the horizon as it dives; a slim strip card
//   detail     opens on a close-up of the building (the carousel crop), then cuts to the globe
//   timer      a longer hover with a gold bar running down: time to guess
//   country    stops when the whole country fills the screen; a gold "?" marks the spot, then a strip card
// Every format has the title "Where am I?" above the clue (TITLE). The country format
// needs Natural Earth's ne_50m_admin_0_countries.geojson in data/.cache/ (public domain:
// raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/).
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

// ---------- formats ----------
// Times in seconds: spin until spinEnd, turn to the region until turnEnd, hover until
// hoverEnd, dive until diveEnd, the pin lands at pinAt, the reveal is in by cardEnd,
// pull back out from outAt; total = the opening frame again, so it loops.
const BASE = { start: 0, spinEnd: 4.0, turnEnd: 5.6, hoverEnd: 6.3, diveEnd: 7.4, pinAt: 8.0, cardEnd: 8.5, outAt: 10.8, total: 11.8,
  spin: -14, reveal: 'card', clue: 'top', pitch: -90, detail: false, timer: false };
const FORMATS = {
  classic: {},
  quick: { spinEnd: 2.4, turnEnd: 3.3, hoverEnd: 3.3, diveEnd: 4.0, pinAt: 4.5, cardEnd: 4.9, outAt: 7.0, total: 7.8, spin: -26 },
  bigclue: { spinEnd: 5.0, turnEnd: 6.6, hoverEnd: 7.3, diveEnd: 8.4, pinAt: 9.0, cardEnd: 9.5, outAt: 11.8, total: 12.8, clue: 'big' },
  fullphoto: { reveal: 'full', outAt: 11.3, total: 12.3 },
  cinematic: { reveal: 'strip', pitch: -32, diveEnd: 7.6, pinAt: 8.2, cardEnd: 8.7, outAt: 11.0, total: 12.0 },
  detail: { start: 2.5, spinEnd: 5.0, turnEnd: 6.6, hoverEnd: 7.3, diveEnd: 8.4, pinAt: 9.0, cardEnd: 9.5, outAt: 11.8, total: 12.8, detail: true },
  timer: { spinEnd: 3.5, turnEnd: 5.0, hoverEnd: 7.5, diveEnd: 8.5, pinAt: 9.0, cardEnd: 9.5, outAt: 11.8, total: 12.8, timer: true },
  country: { reveal: 'strip', country: true, hoverEnd: 5.6, diveEnd: 7.0, pinAt: 7.6, cardEnd: 8.6, outAt: 10.8, total: 11.8 },
  // The two chosen formats (user, 2026-11-23). Neither reveals the building; the
  // question is for the comments.
  //   where: opens on the carousel's close-up crop, then the globe just spins, the clue
  //          above it and "Where am I?" below. No zoom, no pin.
  //   who:   "Who am I?" on top, the clue at the bottom, the globe spins, turns and dives
  //          to the pin. The building is never shown.
  where: { layout: 'where', title: 'Where am I?', reveal: 'none', detail: true, start: 2.5, spinEnd: 11, total: 11, spin: -12,
    turnEnd: 99, hoverEnd: 99, diveEnd: 99, pinAt: 100, cardEnd: 100, outAt: 101 },
  // who stops at ~3,000 km: closer, the map is just forest or desert with no landmarks to place the pin by.
  // One continuous swoop (user, 2026-11-23: "a smooth zoom that zooms in while it's still
  // rotating"): the globe spins fast and, without a pause, slows while it zooms in, coming
  // to rest over the pin at diveEnd; the pin lands at pinAt; from outAt it zooms back out
  // while speeding up the same way. Exactly one full turn, so the last frame is the first.
  who: { layout: 'who', title: 'Who am I?', reveal: 'none', closeAlt: 3_000_000, path: 'swoop', spin: -50, swoopIn: 210,
    spinEnd: 0, turnEnd: 0, hoverEnd: 0, diveEnd: 6.0, pinAt: 6.6, cardEnd: 6.6, outAt: 7.8, total: 11.8 },
};

// <date> (a day in data/social.json) or a building id; for an id, CLUE=<n> picks its clue
// (default the first) and the carousel crop is used if the building has had a post.
const [what, fmtName = 'classic', url = 'http://localhost:4173/'] = process.argv.slice(2);
const isDate = /^\d{4}-\d{2}-\d{2}$/.test(what ?? '');
if (!what || !FORMATS[fmtName]) {
  console.error(`usage: node scripts/make-reel.mjs <YYYY-MM-DD | building id> [${Object.keys(FORMATS).join('|')}] [url]`);
  process.exit(1);
}
const F = { ...BASE, ...FORMATS[fmtName] };
const TITLE = F.title ?? 'Where am I?';
const social = read('data/social.json');
const post = isDate ? social.find((s) => s.date === what) : social.findLast((s) => s.id === what) ?? { id: what };
if (!post) { console.error(`${what} has no Instagram post in data/social.json`); process.exit(1); }
const b = read('data/buildings.json').find((x) => x.id === post.id);
if (!b) { console.error(`unknown building ${post.id}`); process.exit(1); }
let clue;
if (isDate) {
  const day = read('data/schedule.json').find((d) => d.date === what);
  clue = b.clues[day.clues?.[day.ids.indexOf(b.id)] ?? 0] ?? b.clues[0];
} else clue = b.clues[Number(process.env.CLUE ?? 0)] ?? b.clues[0];
const date = isDate ? what : 'sample';
// The opening close-up: CROP=x,y,width (fractions of the large photo, 4:5 like the
// carousel's; look at python scripts/social-grid.py <id>), or the carousel's own crop.
const crop = process.env.CROP ? process.env.CROP.split(',').map(Number) : post.crop;
if (F.detail && !crop) { console.error(`${b.id}: give CROP=x,y,width for the opening close-up`); process.exit(1); }

const big = `social/src/${b.id}.jpg`;
const photoFile = existsSync(new URL(big, root)) ? big : `public/photos/${b.id}.jpg`;
const photo = existsSync(new URL(photoFile, root)) ? readFileSync(new URL(photoFile, root)).toString('base64') : null;
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');

const FPS = 30;
const W = 1080, H = 1920;
const START_LAT = 18;
const HOVER_ALT = 7_000_000;
// Closest height: where one video pixel covers about 600 m (Blue Marble's own pixel
// size at the equator) would be ~1,000 km; a little closer still reads as sharp on a phone.
const CLOSE_ALT = 800_000;
// The country format looks at the country's outline instead of the building: the part
// (mainland or island) that holds the building, or the nearest one.
let T = { lon: b.lon, lat: b.lat };
let countryBox = null;
if (F.country) {
  const geo = JSON.parse(readFileSync(new URL('data/.cache/ne_50m_admin_0_countries.geojson', root), 'utf8'));
  const inRing = (ring, x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let best = null;
  for (const f of geo.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      const d = inRing(ring, b.lon, b.lat) ? 0 : Math.min(...ring.map(([x, y]) => Math.hypot((x - b.lon) * Math.cos((b.lat * Math.PI) / 180), y - b.lat)));
      if (!best || d < best.d) best = { d, ring, name: f.properties.NAME };
    }
  }
  const xs = best.ring.map((p) => p[0]), ys = best.ring.map((p) => p[1]);
  countryBox = { w: Math.min(...xs), e: Math.max(...xs), s: Math.min(...ys), n: Math.max(...ys), name: best.name };
  T = { lon: (countryBox.w + countryBox.e) / 2, lat: (countryBox.s + countryBox.n) / 2 };
}
const next = isDate ? new Date(Date.parse(date + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10) : 'sample';

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

await page.evaluate(async ({ clue, title, name, architect, photo, crop, regular, semi, W, H }) => {
  // Only the globe, full screen, with our overlay on top.
  const css = document.createElement('style');
  css.textContent = `
    @font-face { font-family: ReelPlex; font-weight: 400; src: url(data:font/woff2;base64,${regular}) format('woff2'); }
    @font-face { font-family: ReelPlex; font-weight: 600; src: url(data:font/woff2;base64,${semi}) format('woff2'); }
    body > * { visibility: hidden; }
    #globe { visibility: visible; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 10; }
    #globe .pins { display: none; }
    #reel { visibility: visible; position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: ReelPlex, monospace; color: #ece6da; overflow: hidden; }
    #reel .shadow { text-shadow: 0 2px 6px rgb(0 0 0 / 0.9), 0 0 28px rgb(0 0 0 / 0.75); }
    #reel .clue { position: absolute; left: 90px; right: 90px; top: 170px; text-align: center; font-size: 50px; line-height: 1.38; font-weight: 600; z-index: 3; }
    #reel .bigtitle { position: absolute; left: 60px; right: 60px; top: -400px; text-align: center; color: #e3b261; font-size: 84px; font-weight: 600; z-index: 3; }
    #reel .title { color: #e3b261; font-size: 1.25em; margin-bottom: 18px; }
    #reel .q { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%; background: #e3b261; color: #1a1408;
      display: grid; place-items: center; font-size: 84px; font-weight: 600; opacity: 0; z-index: 2; box-shadow: 0 6px 18px rgb(0 0 0 / 0.5); }
    #reel .clue.big { left: 70px; right: 70px; top: 50%; transform: translateY(-50%); font-size: 64px; line-height: 1.34; padding: 54px 50px;
      background: rgb(14 16 18 / 0.72); border-radius: 30px; text-shadow: none; }
    #reel .timer { position: absolute; left: 240px; right: 240px; top: 500px; height: 12px; border-radius: 6px; background: rgb(14 16 18 / 0.55); z-index: 3; overflow: hidden; }
    #reel .timer i { position: absolute; inset: 0; background: #e3b261; transform-origin: left center; }
    #reel .pin { position: absolute; left: 0; top: 0; width: 84px; height: 112px; margin: -112px 0 0 -42px; opacity: 0; filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.6)); z-index: 2; }
    #reel .ring { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; border: 5px solid #e3b261; border-radius: 50%; opacity: 0; z-index: 2; }
    #reel .card { position: absolute; left: 60px; right: 60px; bottom: 330px; background: #16191c; border: 2px solid #2b3036; border-radius: 32px; overflow: hidden;
      transform: translateY(1400px); box-shadow: 0 20px 60px rgb(0 0 0 / 0.6); z-index: 4; }
    #reel .card .ph { position: relative; height: 540px; overflow: hidden; background: #0e1012; }
    #reel .ph i { position: absolute; inset: -40px; background-size: cover; background-position: center; filter: blur(30px) brightness(0.6); }
    #reel .ph b { position: absolute; inset: 0; background-size: contain; background-position: center; background-repeat: no-repeat; }
    #reel .card .tx { padding: 34px 44px 40px; }
    #reel .nm { font-size: 54px; font-weight: 600; line-height: 1.15; }
    #reel .ar { margin-top: 12px; font-size: 36px; color: #99938a; }
    #reel .strip { position: absolute; left: 60px; right: 60px; bottom: 330px; height: 250px; display: flex; background: #16191c; border: 2px solid #2b3036;
      border-radius: 28px; overflow: hidden; transform: translateY(1400px); box-shadow: 0 20px 60px rgb(0 0 0 / 0.6); z-index: 4; }
    #reel .strip .sp { width: 250px; flex: none; background-size: cover; background-position: center; }
    #reel .strip .tx { padding: 30px 34px; display: flex; flex-direction: column; justify-content: center; }
    #reel .strip .nm { font-size: 44px; } #reel .strip .ar { font-size: 30px; }
    #reel .full { position: absolute; inset: 0; background: #0e1012; transform: translateY(1920px); z-index: 5; overflow: hidden; }
    #reel .full .fp { position: absolute; inset: 0; background-size: cover; background-position: center; }
    #reel .full .tx { position: absolute; left: 0; right: 0; bottom: 0; padding: 320px 70px 380px; background: linear-gradient(transparent, rgb(0 0 0 / 0.8)); }
    #reel .full .ar { color: #d8d2c6; }
    #reel .detail { position: absolute; inset: 0; background-color: #0e1012; background-repeat: no-repeat; z-index: 1; display: none; }
  `;
  document.head.append(css);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reel = document.createElement('div');
  reel.id = 'reel';
  const img = photo ? `url(data:image/jpeg;base64,${photo})` : 'none';
  const tx = `<div class="tx"><div class="nm">${esc(name)}</div><div class="ar">${esc(architect)}</div></div>`;
  reel.innerHTML = `
    <div class="detail" style="background-image:${img}"></div>
    <div class="clue shadow"><div class="title">${esc(title)}</div>${esc(clue)}</div>
    <div class="bigtitle shadow">${esc(title)}</div>
    <div class="timer" hidden><i></i></div>
    <div class="ring"></div>
    <div class="q">?</div>
    <svg class="pin" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.8 1 11.8 1 20.2 12 31 12 31s11-10.8 11-19.2C23 5.8 18.1 1 12 1z" fill="#e3b261" stroke="#1a1408" stroke-width="1"/><circle cx="12" cy="11.6" r="4.2" fill="#1a1408"/></svg>
    <div class="card">${photo ? `<div class="ph"><i style="background-image:${img}"></i><b style="background-image:${img}"></b></div>` : ''}${tx}</div>
    <div class="strip"><div class="sp" style="background-image:${img}"></div>${tx}</div>
    <div class="full"><div class="fp" style="background-image:${img}"></div><div class="shadow">${tx}</div></div>`;
  document.body.append(reel);
  document.getElementById('intro').hidden = true;

  // The close-up opening: the carousel's crop [x, y, width] (fractions of the photo),
  // widened to the screen's 9:16 around the same centre.
  if (photo && crop) {
    const im = new Image();
    im.src = `data:image/jpeg;base64,${photo}`;
    await im.decode();
    const nw = im.naturalWidth, nh = im.naturalHeight;
    const cw = crop[2] * nw, ch = cw * 5 / 4;
    const cx = crop[0] * nw + cw / 2, cy = crop[1] * nh + ch / 2;
    let rw = cw, rh = (cw * H) / W;
    if (rh > nh) { rh = nh; rw = (rh * W) / H; }
    const x0 = Math.max(0, Math.min(nw - rw, cx - rw / 2)), y0 = Math.max(0, Math.min(nh - rh, cy - rh / 2));
    const s = W / rw;
    Object.assign(reel.querySelector('.detail').style, { backgroundSize: `${nw * s}px ${nh * s}px`, backgroundPosition: `${-x0 * s}px ${-y0 * s}px` });
  }

  const g = window.__landmarked.globe;
  const scene = g.widget.scene;
  // Lift the zoom limit (the reel sets its own).
  scene.screenSpaceCameraController.minimumZoomDistance = 1;
  g.closestAlt = () => 1;
}, { clue, title: TITLE, name: b.name, architect: b.architect, photo, crop, regular: font(400), semi: font(600), W, H });
await page.evaluate(() => document.fonts.ready);

// Layout: shrink long clues so they end by about y=620, make the card's photo shorter if
// the gap above it gets tight, put the timer under the clue, and find the free band
// between the clue and the reveal, where the pin (or the country) goes.
const L = await page.evaluate(({ H }) => {
  const $ = (s) => document.querySelector('#reel ' + s);
  const clueEl = $('.clue');
  for (const fs of [50, 46, 42, 39]) { clueEl.style.fontSize = fs + 'px'; clueEl.dataset.fs = fs + 'px'; if (clueEl.getBoundingClientRect().bottom <= 620) break; }
  const clueBottom = clueEl.getBoundingClientRect().bottom;
  const card = $('.card'), ph = $('.card .ph');
  const cardTop = () => H - 330 - card.offsetHeight;
  if (ph) ph.style.height = Math.max(400, Math.min(540, 540 - (clueBottom + 300 - cardTop()))) + 'px';
  $('.timer').style.top = clueBottom + 34 + 'px';
  return { clueBottom, cardTop: cardTop(), stripTop: H - 330 - $('.strip').offsetHeight };
}, { H });
const freeTop = L.clueBottom + 30;
const freeBottom = F.reveal === 'card' ? L.cardTop - 20 : F.reveal === 'strip' ? L.stripTop - 30 : H - 420;
// The pin is drawn above its tip, so its tip sits a little below the middle of the band.
let PIN_Y = F.country ? (freeTop + freeBottom) / 2 : Math.min(freeBottom - 20, (freeTop + freeBottom) / 2 + 60);
// Closest height: CLOSE_ALT, or for the country format high enough that its outline
// fits the free band and the screen's width, with a margin.
let closeAlt = F.closeAlt ?? CLOSE_ALT;
if (countryBox) {
  const tan = Math.tan(Math.PI / 6);
  const hM = (countryBox.n - countryBox.s) * 111_320;
  const wM = (countryBox.e - countryBox.w) * 111_320 * Math.cos((T.lat * Math.PI) / 180);
  const fitH = (hM * 1.2 * H) / ((freeBottom - freeTop) * 2 * tan);
  const fitW = (wM * 1.15 * H) / (W * 2 * tan);
  closeAlt = Math.max(1_000_000, Math.min(12_000_000, Math.max(fitH, fitW)));
  console.log(`country: ${countryBox.name}, ${Math.round(wM / 1000)} × ${Math.round(hM / 1000)} km, stops at ${Math.round(closeAlt / 1000)} km`);
}
const hoverAlt = Math.max(HOVER_ALT, closeAlt * 1.6);

// Home height: the whole globe fits the width, with a margin; a bit smaller than in the
// game, so the clue sits clear above it.
let HOME = await page.evaluate(() => window.__landmarked.globe.homeAlt()) * 1.18;

// The two chosen layouts: a big gold title and the clue around a globe that sits in the
// band between them. The globe canvas is made taller and moved so its centre is the
// band's centre (the camera always looks at the canvas centre).
let canvasTop = 0, Hc = H;
if (F.layout) {
  const G = await page.evaluate(({ layout, H }) => {
    const $ = (s) => document.querySelector('#reel ' + s);
    const clueEl = $('.clue'), title = $('.bigtitle');
    $('.clue .title').remove();
    if (layout === 'who') {
      // Title on top, clue at the bottom (above Instagram's caption area).
      title.style.top = '170px';
      Object.assign(clueEl.style, { top: 'auto', bottom: '430px' });
      for (const fs of [50, 46, 42, 39]) { clueEl.style.fontSize = fs + 'px'; clueEl.dataset.fs = fs + 'px'; if (clueEl.offsetHeight <= 420) break; }
      const tb = title.getBoundingClientRect().bottom, ct = clueEl.getBoundingClientRect().top;
      return { top: tb + 50, bottom: ct - 50 };
    }
    // where: clue on top, title under the globe.
    const cb = clueEl.getBoundingClientRect().bottom;
    const th = title.offsetHeight;
    const bottom = H - 430 - th - 40;
    title.style.top = bottom + 40 + 'px';
    return { top: cb + 50, bottom };
  }, { layout: F.layout, H });
  const cy = (G.top + G.bottom) / 2;
  const r = Math.min((G.bottom - G.top) / 2, 470);
  Hc = Math.round(H + 2 * Math.abs(cy - H / 2));
  canvasTop = Math.round(cy - Hc / 2);
  await page.evaluate(({ top, h }) => {
    const el = document.getElementById('globe');
    el.style.setProperty('inset', 'auto', 'important');
    el.style.setProperty('left', '0', 'important');
    el.style.setProperty('top', top + 'px', 'important');
    el.style.setProperty('height', h + 'px', 'important');
    window.__landmarked.globe.widget.resize();
  }, { top: canvasTop, h: Hc });
  // Height at which the globe's radius on screen is r pixels (60° across the canvas height).
  const R = 6_378_137;
  const a = Math.atan((r * Math.tan(Math.PI / 6)) / (Hc / 2));
  HOME = R / Math.sin(a) - R;
  PIN_Y = cy + 40;
  console.log(`layout ${F.layout}: globe band ${Math.round(G.top)}–${Math.round(G.bottom)} px, radius ${Math.round(r)} px`);
}

const clamp = (u) => Math.max(0, Math.min(1, u));
const ease = (u) => u * u * (3 - 2 * u);
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const logLerp = (a, b, u) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
// Hermite curve from p0 (speed m0) to p1 (speed m1), u in 0..1, speeds per whole segment.
const hermite = (p0, p1, m0, m1, u) =>
  (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * m0 + (-2 * u ** 3 + 3 * u ** 2) * p1 + (u ** 3 - u ** 2) * m1;
const DEG_M = 111_320;
// Where the spin starts, so that it flows into the turn without stopping (the turn
// covers about spin·duration/2 more degrees while it slows down).
const lon0 = F.path === 'swoop' ? T.lon + F.swoopIn : T.lon - F.spin * (F.spinEnd - F.start + (F.turnEnd - F.spinEnd) / 2);
// Top-down: look a little south of the building near the ground so its pin sits at
// PIN_Y (the camera looks straight down, 60° across the height).
const shiftAt = (alt) => (((Hc / 2 - (PIN_Y - canvasTop)) / Hc) * 2 * Math.tan(Math.PI / 6) * alt) / DEG_M;

// The camera's look-at point (lon, lat), height and tilt amount k (0..1).
function view(t) {
  if (F.path === 'swoop') {
    // In: from the opening spin speed to rest over the target while zooming in.
    if (t <= F.diveEnd) {
      const d = F.diveEnd, u = t / d, k = easeInOut(u);
      return { lon: hermite(lon0, T.lon, F.spin * d, 0, u), lat: START_LAT + (T.lat - START_LAT) * ease(u), alt: logLerp(HOME, closeAlt, k), k };
    }
    if (t <= F.outAt) return { lon: T.lon, lat: T.lat, alt: closeAlt, k: 1 };
    // Out: from rest back up to the opening speed, ending one full turn on, at the opening frame.
    const d = F.total - F.outAt, u = (t - F.outAt) / d, k = 1 - easeInOut(u);
    return { lon: hermite(T.lon, lon0 - 360, 0, F.spin * d, u), lat: T.lat + (START_LAT - T.lat) * ease(u), alt: logLerp(closeAlt, HOME, easeInOut(u)), k };
  }
  const s = Math.max(t, F.start);
  if (s <= F.spinEnd) return { lon: lon0 + F.spin * (s - F.start), lat: START_LAT, alt: HOME, k: 0 };
  if (s <= F.turnEnd) {
    const d = F.turnEnd - F.spinEnd, u = (s - F.spinEnd) / d;
    return { lon: hermite(lon0 + F.spin * (F.spinEnd - F.start), T.lon, F.spin * d, 0, u), lat: START_LAT + (T.lat - START_LAT) * ease(u), alt: logLerp(HOME, hoverAlt, easeOut(u)), k: 0 };
  }
  if (s <= F.hoverEnd) {
    // Nearly still, drifting in a touch so it doesn't look frozen.
    const u = (s - F.turnEnd) / Math.max(0.01, F.hoverEnd - F.turnEnd);
    return { lon: T.lon, lat: T.lat, alt: logLerp(hoverAlt, hoverAlt * 0.9, u), k: 0 };
  }
  if (s <= F.diveEnd) {
    const k = easeInOut((s - F.hoverEnd) / (F.diveEnd - F.hoverEnd));
    return { lon: T.lon, lat: T.lat, alt: logLerp(hoverAlt * 0.9, closeAlt, k), k };
  }
  if (s <= F.outAt) return { lon: T.lon, lat: T.lat, alt: closeAlt, k: 1 };
  // Pull back out to the opening frame, arriving at the spin's speed so the loop is seamless.
  const d = F.total - F.outAt, u = (s - F.outAt) / d;
  return { lon: hermite(T.lon, lon0, 0, F.spin * d, u), lat: T.lat + (START_LAT - T.lat) * easeInOut(u), alt: logLerp(closeAlt, HOME, easeInOut(u)), k: 1 - easeInOut(clamp(u * 1.6)) };
}
function camera(t) {
  const v = view(t);
  const pitch = -90 + (F.pitch + 90) * v.k; // degrees
  if (F.pitch <= -89.9) return { lon: v.lon, lat: v.lat - shiftAt(v.alt) * v.k, alt: v.alt, pitch: -90 };
  // Tilted: stand south of the look-at point at the same eye height, so the dive feels the same.
  const back = v.alt / Math.tan((-pitch * Math.PI) / 180);
  return { lon: v.lon, lat: v.lat - back / DEG_M, alt: v.alt, pitch };
}

function overlay(t) {
  const DROP = F.pinAt - F.diveEnd;
  const pinU = clamp((t - F.diveEnd) / DROP);
  // Pin: drops from above with a small bounce, landing at pinAt; a ring pulses out.
  const bounce = pinU < 0.75 ? easeOut(pinU / 0.75) : 1 - Math.sin(((pinU - 0.75) / 0.25) * Math.PI) * 0.06;
  const inU = easeOut(clamp((t - F.pinAt) / (F.cardEnd - F.pinAt)));
  const outU = clamp((t - F.outAt) / 0.45) ** 2;
  const shown = t < F.outAt ? inU : 1 - outU;
  return {
    pinOpacity: !F.country && t > F.diveEnd ? 1 - clamp((t - F.outAt) / 0.25) : 0,
    q: F.country && t > F.diveEnd ? Math.min(easeOut(pinU) * (1 + 0.15 * Math.sin(pinU * Math.PI)), 1 - clamp((t - F.outAt) / 0.25)) : 0,
    pinDrop: (1 - bounce) * -420,
    ringU: clamp((t - (F.diveEnd + DROP * 0.75)) / 0.8),
    card: F.reveal === 'card' ? (1 - shown) * 1400 : 1400,
    strip: F.reveal === 'strip' ? (1 - shown) * 1400 : 1400,
    full: F.reveal === 'full' ? (1 - shown) * 1920 : 1920,
    fullScale: 1 + 0.06 * clamp((t - F.pinAt) / (F.outAt - F.pinAt)), // slow push-in on the photo
    clueBig: F.clue === 'big' && t < F.hoverEnd,
    clueHidden: F.reveal === 'full' && t >= F.cardEnd && t < F.outAt,
    detail: F.detail && t < F.start,
    timer: F.timer && t >= F.turnEnd && t < F.hoverEnd ? 1 - (t - F.turnEnd) / (F.hoverEnd - F.turnEnd) : -1,
  };
}

const n = Math.round(F.total * FPS);
const words = clue.split(/\s+/).length;
console.log(`${b.name} (post on ${next}), ${fmtName}: ${words}-word clue, ${F.total.toFixed(1)} s, pin at ${F.pinAt} s, ${n} frames`);
const t0 = Date.now();
const only = process.env.AT ? process.env.AT.split(',').map((x) => Math.min(n - 1, Math.round(Number(x) * FPS))) : null;
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  const t = i / FPS;
  await page.evaluate(({ cam, ov, lon, lat, top }) => {
    const scene = window.__landmarked.globe.widget.scene;
    const C3 = scene.camera.position.constructor;
    scene.camera.setView({ destination: C3.fromDegrees(cam.lon, cam.lat, cam.alt), orientation: { heading: 0, pitch: (cam.pitch * Math.PI) / 180, roll: 0 } });
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
    $('.pin').style.opacity = ov.pinOpacity;
    $('.pin').style.transform = `translate(${x}px, ${y + ov.pinDrop}px)`;
    $('.q').style.opacity = ov.q > 0 ? 1 : 0;
    $('.q').style.transform = `translate(${x}px, ${y}px) scale(${Math.max(0, ov.q)})`;
    $('.ring').style.transform = `translate(${x}px, ${y}px) scale(${0.3 + ov.ringU * 1.6})`;
    $('.ring').style.opacity = ov.ringU > 0 && ov.ringU < 1 ? 1 - ov.ringU : 0;
    $('.card').style.transform = `translateY(${ov.card}px)`;
    $('.strip').style.transform = `translateY(${ov.strip}px)`;
    $('.full').style.transform = `translateY(${ov.full}px)`;
    $('.full .fp').style.transform = `scale(${ov.fullScale})`;
    $('.clue').classList.toggle('big', ov.clueBig);
    $('.clue').style.fontSize = ov.clueBig ? '' : $('.clue').dataset.fs;
    $('.clue').style.visibility = ov.clueHidden || ov.detail ? 'hidden' : '';
    $('.bigtitle').style.visibility = ov.detail ? 'hidden' : '';
    $('.detail').style.display = ov.detail ? 'block' : 'none';
    $('.timer').hidden = ov.timer < 0;
    $('.timer i').style.transform = `scaleX(${Math.max(0, ov.timer)})`;
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
if (only) { console.log(`frames in social/reels/.frames-${date}/`); process.exit(0); }

const name = `${next}-${b.id}-${fmtName}.mp4`;
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}%04d.png`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path(`social/reels/${name}`)]);
rmSync(frames, { recursive: true, force: true });
console.log(`wrote social/reels/${name}`);
