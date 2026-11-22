// Plays a full day in a real (headless) Chrome at phone and desktop sizes and
// saves screenshots. Guesses are the true location nudged by a few hundred km,
// so every screen state (result card, end screen, share, show-all) appears.
//
// Usage: node scripts/playtest.mjs [url] [outDir]
//   url defaults to http://localhost:4173/landmarked/ (npm run build && npm run preview)
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome } from './chrome.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/landmarked/';
const out = process.argv[3] ?? 'playtest-shots';
mkdirSync(out, { recursive: true });
const buildings = JSON.parse(readFileSync(new URL('../data/buildings.json', import.meta.url), 'utf8'));

const DEVICES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1366, height: 820, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
// Offsets (deg) for the five guesses: a near-miss, a fair guess, a bullseye, two misses.
const OFFSETS = [[0.05, 0.03], [2.5, -1.5], [0, 0], [-6, 4], [12, -8]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(page, extra = 600) {
  // camera flights are ~1.8 s; wait until tiles settle
  await page.waitForFunction(() => window.__landmarked?.globe, { timeout: 60_000 });
  await sleep(2000);
  await page.waitForFunction(() => window.__landmarked.globe.widget.scene.globe.tilesLoaded, { timeout: 30_000 }).catch(() => {});
  await sleep(extra);
}

async function tapLonLat(page, lon, lat, touch) {
  const pt = await page.evaluate(
    ([lon, lat]) => {
      const scene = window.__landmarked.globe.widget.scene;
      const C3 = scene.camera.position.constructor;
      const p = scene.cartesianToCanvasCoordinates(C3.fromDegrees(lon, lat, 0));
      const r = scene.canvas.getBoundingClientRect();
      return p && { x: r.left + p.x, y: r.top + p.y };
    },
    [lon, lat],
  );
  if (!pt) throw new Error(`(${lon}, ${lat}) not on screen`);
  if (touch) await page.touchscreen.tap(pt.x, pt.y);
  else await page.mouse.click(pt.x, pt.y);
  return pt;
}

async function run(name) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.emulateTimezone('Europe/Zurich');
  await page.setViewport(DEVICES[name]);
  const touch = DEVICES[name].hasTouch;
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: join(out, `${name}-0-intro-instant.png`) });
  await waitIdle(page);
  await page.screenshot({ path: join(out, `${name}-1-intro.png`) });
  await page.click('#play-btn');
  await sleep(300);

  const ids = await page.evaluate(() => {
    const day = new URLSearchParams(location.search).get('day');
    return JSON.parse(localStorage.getItem(day ? `landmarked:day:${day}` : Object.keys(localStorage).filter((k) => k.startsWith('landmarked:day:')).sort().pop())).ids;
  });
  const log = [];
  for (let i = 0; i < 5; i++) {
    const b = buildings.find((x) => x.id === ids[i]);
    // The camera starts over the player's longitude; spin to the target first, like a player would.
    await page.evaluate(([lon, lat]) => {
      const scene = window.__landmarked.globe.widget.scene;
      const C3 = scene.camera.position.constructor;
      scene.camera.setView({ destination: C3.fromDegrees(lon, lat, 1.2e7) });
      scene.requestRender();
    }, [b.lon + 10, b.lat - 5]);
    await sleep(800);
    if (i === 0) await page.screenshot({ path: join(out, `${name}-2-question.png`) });

    const [dx, dy] = OFFSETS[i];
    await tapLonLat(page, b.lon + dx, b.lat + dy, touch);
    await waitIdle(page, 800);
    await page.screenshot({ path: join(out, `${name}-4-result-${i + 1}.png`) });
    const r = await page.evaluate(() => ({
      pts: document.getElementById('r-points').textContent,
      dist: document.getElementById('r-distance').textContent,
      name: document.getElementById('r-name').textContent,
      score: document.getElementById('score').textContent,
    }));
    log.push(`${i + 1}. ${b.tier.padEnd(6)} ${r.name} — ${r.pts} pts, ${r.dist} (score ${r.score})`);

    if (i === 1) {
      // Reload mid-day: should resume at question 3.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitIdle(page);
      const btn = await page.$eval('#play-btn', (e) => e.textContent);
      log.push(`   reload → intro button: "${btn}"`);
      await page.click('#play-btn');
      await sleep(300);
      continue;
    }
    await page.click('#next-btn');
    await sleep(2200);
  }
  await sleep(1200);
  await page.screenshot({ path: join(out, `${name}-5-end.png`) });
  const share = await page.$eval('#share-text', (e) => e.textContent);
  await page.click('#showall-btn');
  await waitIdle(page, 1000);
  await page.screenshot({ path: join(out, `${name}-6-all.png`) });
  // Tap the first visible building chip: its card opens over the globe.
  const chip = await page.$$eval('.pin', (els) => els.findIndex((e) => e.style.visibility !== 'hidden'));
  if (chip >= 0) {
    await (await page.$$('.pin'))[chip].click();
    await waitIdle(page, 1000);
    await page.screenshot({ path: join(out, `${name}-6b-pin.png`) });
    log.push(`   pin card: ${await page.$eval('#pin-sheet h4', (e) => e.textContent)}`);
    await page.click('#pin-sheet .close');
  } else log.push('   no visible pin chips');
  await page.click('#menu-btn');
  await sleep(300);
  await page.screenshot({ path: join(out, `${name}-7-help.png`) });

  console.log(`\n=== ${name} ===\n${log.join('\n')}\n--- share ---\n${share}\n--- errors: ${errors.length}`);
  for (const e of errors) console.log('  ' + e.slice(0, 200));
  await browser.close();
}

for (const d of process.argv[4] ? [process.argv[4]] : Object.keys(DEVICES)) await run(d);
