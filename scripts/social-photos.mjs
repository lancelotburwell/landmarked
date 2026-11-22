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

for (const id of process.argv.slice(2)) {
  const out = new URL(`social/src/${id}.jpg`, root);
  if (existsSync(out)) { console.log(id, 'cached'); continue; }
  const file = decodeURIComponent(credits[id].page.split('/wiki/')[1]);
  const q = new URLSearchParams({ action: 'query', titles: file, prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: process.env.W ?? '1920', format: 'json' });
  const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: UA })).json();
  const info = Object.values(j.query.pages)[0].imageinfo[0];
  const src = info.width <= Number(process.env.W ?? 1920) ? info.url : info.thumburl;
  const res = await fetch(src, { headers: UA });
  if (!res.ok) { console.log(id, 'failed', res.status); continue; }
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(id, `${info.width}x${info.height}`, '->', Math.min(info.width, 2400));
  await new Promise((r) => setTimeout(r, 6000));
}
