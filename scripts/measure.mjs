// Measures bundle transfer and time to an interactive globe on a throttled
// connection (Chrome DevTools "Fast 4G" preset), cold and warm (service worker).
// Usage: node scripts/measure.mjs [url] [runs]
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/landmarked/';
const runs = Number(process.argv[3] ?? 3);
// DevTools presets (same numbers Chrome uses, incl. its 0.9 / latency factors).
const FAST_4G = { offline: false, latency: 60 * 2.75, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 };

async function once(browser, label, page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FAST_4G);
  let bytes = { app: 0, cesium: 0, tiles: 0, other: 0 };
  cdp.on('Network.loadingFinished', (e) => (sizes[e.requestId] = e.encodedDataLength));
  const sizes = {}, urls = {};
  cdp.on('Network.requestWillBeSent', (e) => (urls[e.requestId] = e.request.url));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__landmarked?.tilesLoaded, { timeout: 120_000, polling: 100 });
  const t = await page.evaluate(() => {
    const m = (n) => Math.round(performance.getEntriesByName(n)[0]?.startTime ?? NaN);
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
    return { fcp: Math.round(fcp), ui: m('ui-ready'), cesium: m('cesium-loaded'), globe: m('globe-ready'), tiles: m('globe-tiles-loaded') };
  });
  for (const [id, n] of Object.entries(sizes)) {
    const u = urls[id] ?? '';
    const k = /eox|gibs/.test(u) ? 'tiles' : /\/cesium\//.test(u) ? 'cesium' : /\/assets\/|\.html|\/$|borders/.test(u) ? 'app' : 'other';
    bytes[k] += n;
  }
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log(`${label.padEnd(5)} FCP ${t.fcp} ms | UI ${t.ui} ms | engine loaded ${t.cesium} ms | globe drawn ${t.globe} ms | first tiles complete ${t.tiles} ms | over the wire: app ${kb(bytes.app)}, cesium static ${kb(bytes.cesium)}, tiles ${kb(bytes.tiles)}`);
  await cdp.detach();
  return t;
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
console.log(`${url} — Fast 4G (${(FAST_4G.downloadThroughput * 8 / 1e6).toFixed(1)} Mbps down, ${FAST_4G.latency} ms RTT)`);
for (let i = 0; i < runs; i++) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await once(browser, 'cold', page);
  await new Promise((r) => setTimeout(r, 1500)); // let the service worker finish caching
  await once(browser, 'warm', page);
  await ctx.close();
}
await browser.close();
