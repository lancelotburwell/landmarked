// Which Instagram posts still need rendering: dates from today on in data/social.json
// without both images in public/social/ or without an entry in data/social-captions.json.
// Prints two lines for the social GitHub Action: the building ids, then the dates.
//
//   node scripts/social-pending.mjs
import { existsSync } from 'node:fs';
import { root, readOr, today } from './lib/plan.mjs';

const t = today();
const captioned = new Set(readOr('data/social-captions.json', []).map((c) => c.date));
const todo = readOr('data/social.json', []).filter((p) => p.date >= t && (
  !captioned.has(p.date) || ![1, 2].every((n) => existsSync(new URL(`public/social/${p.date}-${n}.jpg`, root)))
));
console.log([...new Set(todo.map((p) => p.id))].join(' '));
console.log(todo.map((p) => p.date).join(' '));
