// Downloads large versions of building photos from Wikimedia Commons for the
// Instagram sneak-peek crops, into social/src/<id>.jpg (gitignored). Wikimedia
// only serves standard thumbnail widths quickly: W=1920 (default) or W=3840.
//   node scripts/social-photos.mjs alhambra habitat-67 ...
//   W=3840 node scripts/social-photos.mjs forbidden-city
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const credits = JSON.parse(readFileSync(new URL('public/photos/credits.json', root), 'utf8'));
const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };
mkdirSync(new URL('social/src/', root), { recursive: true });

// FILE="File:…jpg" node scripts/social-photos.mjs <id>: a different Commons photo for a reel
// (a closer, sharper detail than the game's photo), saved as social/src/<id>-reel.jpg with
// its credit in <id>-reel.json; make-reel.mjs prefers it. CC0/PD/CC BY/CC BY-SA only.
const FILE = process.env.FILE;
for (const id of process.argv.slice(2)) {
  const out = new URL(`social/src/${id}${FILE ? '-reel' : ''}.jpg`, root);
  if (existsSync(out) && !FILE) { console.log(id, 'cached'); continue; }
  const file = FILE ?? decodeURIComponent(credits[id].page.split('/wiki/')[1]);
  const q = new URLSearchParams({ action: 'query', titles: file, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: process.env.W ?? '1920', format: 'json' });
  const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: UA })).json();
  const info = Object.values(j.query.pages)[0].imageinfo[0];
  if (FILE) {
    const m = info.extmetadata;
    const license = m.LicenseShortName?.value ?? '';
    if (!/^(cc0|cc by(-sa)? [\d.]+|public domain|pd)/i.test(license)) { console.log(id, `licence "${license}" not allowed`); continue; }
    const artist = (m.Artist?.value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    writeFileSync(new URL(`social/src/${id}-reel.json`, root),
      JSON.stringify({ artist, license, page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.replace(/ /g, '_'))}` }, null, 1));
  }
  const src = info.width <= Number(process.env.W ?? 1920) ? info.url : info.thumburl;
  const res = await fetch(src, { headers: UA });
  if (!res.ok) { console.log(id, 'failed', res.status); continue; }
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(id, `${info.width}x${info.height}`, '->', Math.min(info.width, 2400));
  await new Promise((r) => setTimeout(r, 6000));
}
