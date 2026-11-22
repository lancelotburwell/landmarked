import { existsSync } from 'node:fs';

/** Finds a local Chrome/Edge for puppeteer-core (set CHROME_PATH to override). */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error('No Chrome found; set CHROME_PATH');
  return hit;
}
