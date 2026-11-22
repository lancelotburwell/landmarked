// Renders the link-preview image (public/og.jpg, 1200×630) shown when a
// landmarked.land link is shared: the game's own globe (public-domain NASA
// imagery) with pins on a few buildings, and the tagline. No building photos,
// so no licence credits are needed.
//
//   npm run build && npx vite preview --port 4173, then
//   node scripts/make-og.mjs http://localhost:4173/
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const borders = JSON.parse(readFileSync(new URL('public/borders.json', root), 'utf8'));
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');
const pins = JSON.parse(readFileSync(new URL('data/buildings.json', root), 'utf8'))
  .filter((b) => ['eiffel-tower', 'colosseum', 'taj-mahal', 'burj-khalifa', 'hassan-ii-mosque', 'hagia-sophia', 'great-mosque-djenne', 'zeitz-mocaa'].includes(b.id))
  .map((b) => [b.lon, b.lat]);

const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

// 1. The globe, centred on Europe and Africa, on the page background colour.
const game = await browser.newPage();
await game.setViewport({ width: 760, height: 900, deviceScaleFactor: 1 });
await game.goto(url, { waitUntil: 'domcontentloaded' });
await game.waitForFunction(() => window.__landmarked?.globe, { timeout: 90_000 });
await game.evaluate(() => {
  document.getElementById('intro').hidden = true;
  const { widget } = window.__landmarked.globe;
  const scene = widget.scene;
  const C3 = scene.camera.position.constructor;
  const h = scene.camera.positionCartographic.height * 0.98;
  scene.camera.setView({ destination: C3.fromDegrees(28, 22, h) });
  Object.assign(scene.backgroundColor, { red: 14 / 255, green: 16 / 255, blue: 18 / 255, alpha: 1 });
  if (scene.skyBox) scene.skyBox.show = false;
  // Hide the country-code labels; keep the borders.
  for (let i = 0; i < scene.primitives.length; i++) {
    const p = scene.primitives.get(i);
    if (p && typeof p.add === 'function' && 'totalGlyphCount' in p) p.show = false;
  }
});
await new Promise((r) => setTimeout(r, 3000));
await game.waitForFunction(() => window.__landmarked.globe.widget.scene.globe.tilesLoaded, { timeout: 60_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const shot = await (await game.$('#globe')).screenshot({ encoding: 'base64' });
const box = await game.evaluate(() => {
  const scene = window.__landmarked.globe.widget.scene;
  const C3 = scene.camera.position.constructor;
  const r = scene.canvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
await game.close();

const html = `<!doctype html><html><head><style>
@font-face { font-family: Plex; font-weight: 400; src: url(data:font/woff2;base64,${font(400)}) format('woff2'); }
@font-face { font-family: Plex; font-weight: 600; src: url(data:font/woff2;base64,${font(600)}) format('woff2'); }
html, body { margin: 0; width: 1200px; height: 630px; background: #0e1012; overflow: hidden; }
.globe { position: absolute; right: -40px; top: 50%; width: 600px; height: 600px; transform: translateY(-50%); background: url(data:image/png;base64,${shot}) center / contain no-repeat; }
.text { position: absolute; left: 72px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 22px; font-family: Plex; color: #ece6da; }
.logo { display: flex; align-items: center; gap: 14px; font-weight: 600; font-size: 30px; letter-spacing: 0.14em; color: #e3b261; }
h1 { margin: 0; font-size: 56px; line-height: 1.08; font-weight: 600; letter-spacing: -0.01em; }
p { margin: 0; font-size: 28px; line-height: 1.4; color: #99938a; }
.url { margin-top: 18px; font-size: 26px; font-weight: 600; color: #e3b261; }
</style></head><body>
<div class="globe"></div>
<div class="text">
  <div class="logo"><svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 2.5c-3.9 0-7 3-7 6.9 0 5.4 7 12.1 7 12.1s7-6.7 7-12.1c0-3.9-3.1-6.9-7-6.9z" fill="#e3b261"/><circle cx="12" cy="9.4" r="2.6" fill="#0e1012"/></svg>LANDMARKED</div>
  <h1>Five famous<br>buildings a day.</h1>
  <p>One clue each.<br>Find them on the globe.</p>
  <div class="url">landmarked.land</div>
</div>
</body></html>`;

const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: new URL('public/og.jpg', root).pathname.replace(/^\/([A-Z]:)/, '$1') });
await browser.close();
console.log('wrote public/og.jpg');
