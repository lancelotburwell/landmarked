// Responsiveness check: at phone size, spins the globe for 90 frames and zooms in
// and out, then reports frame times, tile requests and bytes downloaded.
// Software rendering (SwiftShader) is slower than a real phone GPU, so compare
// runs with each other rather than reading the numbers as absolute.
//
//   node scripts/perf.mjs [url]
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/';
// Optional JS run in the page first, with `scene` and `globe` in scope, to try a setting.
const tweak = process.argv[3] ?? '';
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
let tiles = 0, tileBytes = 0;
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
const urls = {};
cdp.on('Network.requestWillBeSent', (e) => { urls[e.requestId] = e.request.url; if (/gibs|eox/.test(e.request.url)) tiles++; });
cdp.on('Network.loadingFinished', (e) => { if (/gibs|eox/.test(urls[e.requestId] ?? '')) tileBytes += e.encodedDataLength; });

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__landmarked?.tilesLoaded, { timeout: 120_000, polling: 100 });
const firstTiles = Date.now() - t0;
const tilesAtStart = tiles;

const result = await page.evaluate(async (tweak) => {
  const { widget } = window.__landmarked.globe;
  const scene = widget.scene;
  const globe = scene.globe;
  if (tweak) { new Function("scene", "globe", tweak)(scene, globe); scene.render(); await new Promise((r) => setTimeout(r, 1500)); }
  const cam = scene.camera;
  const frames = [];
  const C3 = cam.position.constructor;
  const canvas = scene.canvas;
  async function run(n, step) {
    for (let i = 0; i < n; i++) {
      step(i);
      const s = performance.now();
      scene.render();
      frames.push(performance.now() - s);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  // Spin, then zoom in towards Europe and back out.
  await run(90, () => cam.rotate(C3.UNIT_Z, 0.02));
  const h = cam.positionCartographic.height;
  await run(60, (i) => cam.zoomIn(h * 0.05));
  await new Promise((r) => setTimeout(r, 2500));
  await run(60, (i) => cam.zoomOut(h * 0.05));
  const worst = frames.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([t, i]) => `${t.toFixed(0)}ms@${i}`).join(" ");
  frames.sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return {
    canvas: `${canvas.width}x${canvas.height}`,
    avg: avg.toFixed(1),
    p90: frames[Math.floor(frames.length * 0.9)].toFixed(1),
    max: frames[frames.length - 1].toFixed(1),
    worst,
  };
}, tweak);
await new Promise((r) => setTimeout(r, 3000));
console.log(`first tiles complete ${firstTiles} ms (${tilesAtStart} tile requests) | canvas ${result.canvas} px | frame avg ${result.avg} ms, p90 ${result.p90} ms, max ${result.max} ms (worst: ${result.worst}) | total tiles ${tiles}, ${(tileBytes / 1024).toFixed(0)} KB`);
await browser.close();
