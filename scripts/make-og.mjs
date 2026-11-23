// Renders the link-preview image (public/og.jpg, 1200×630) shown when a
// landmarked.land link is shared: just the game's own globe (public-domain
// NASA imagery), centred, with no text (user's choice, 2026-11-23), so it
// still reads when apps crop the preview to a square.
//
//   npm run build && npx vite preview --port 4173, then
//   node scripts/make-og.mjs http://localhost:4173/
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);

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
});
await new Promise((r) => setTimeout(r, 3000));
await game.waitForFunction(() => window.__landmarked.globe.widget.scene.globe.tilesLoaded, { timeout: 60_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
// Just the globe: hide borders, country codes and markers (they load late).
await game.evaluate(() => {
  const prims = window.__landmarked.globe.widget.scene.primitives;
  for (let i = 0; i < prims.length; i++) prims.get(i).show = false;
  window.__landmarked.globe.widget.scene.requestRender();
});
await new Promise((r) => setTimeout(r, 500));
const shot = await (await game.$('#globe')).screenshot({ encoding: 'base64' });
const box = await game.evaluate(() => {
  const scene = window.__landmarked.globe.widget.scene;
  const C3 = scene.camera.position.constructor;
  const r = scene.canvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
await game.close();

const html = `<!doctype html><html><head><style>
html, body { margin: 0; width: 1200px; height: 630px; background: #0e1012; overflow: hidden; }
.globe { position: absolute; left: 50%; top: 50%; width: 600px; height: 600px; transform: translate(-50%, -50%); background: url(data:image/png;base64,${shot}) center / contain no-repeat; }
</style></head><body><div class="globe"></div></body></html>`;

const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: new URL('public/og.jpg', root).pathname.replace(/^\/([A-Z]:)/, '$1') });
await browser.close();
console.log('wrote public/og.jpg');
