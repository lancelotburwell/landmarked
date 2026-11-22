// Screenshots the same views with each imagery source, for side-by-side comparison.
// Usage: node scripts/compare-imagery.mjs [url] [outDir]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { findChrome } from './chrome.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/landmarked/';
const out = process.argv[3] ?? 'imagery-shots';
mkdirSync(out, { recursive: true });
const VIEWS = [
  ['globe', 15, 30, 1.6e7],
  ['europe', 12, 45, 3.0e6],
  ['italy', 12.5, 42, 6.0e5],
  ['rome-150km', 12.49, 41.89, 1.5e5],
  ['rome-40km', 12.49, 41.89, 4.0e4],
  ['dubai-60km', 55.27, 25.2, 6.0e4],
  ['sydney-40km', 151.21, -33.86, 4.0e4],
  ['nyc-40km', -73.98, 40.75, 4.0e4],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const imagery of ['eox', 'nasa']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 640 });
  await page.goto(`${url}?imagery=${imagery}`);
  await page.waitForFunction(() => window.__landmarked?.globe, { timeout: 90_000 });
  await page.addStyleTag({ content: '.topbar,.hud,.bottombar,#intro{display:none!important} #app{grid-template-rows:1fr!important}' });
  for (const [name, lon, lat, alt] of VIEWS) {
    await page.evaluate(([lon, lat, alt]) => {
      const s = window.__landmarked.globe.widget.scene;
      s.camera.setView({ destination: s.camera.position.constructor.fromDegrees(lon, lat, alt) });
      s.requestRender();
    }, [lon, lat, alt]);
    await sleep(1500);
    await page.waitForFunction(() => window.__landmarked.globe.widget.scene.globe.tilesLoaded, { timeout: 60_000, polling: 200 }).catch(() => console.log('timeout', imagery, name));
    await sleep(700);
    await page.screenshot({ path: `${out}/${imagery}-${name}.png` });
  }
  await page.close();
}
await browser.close();
console.log('done');
