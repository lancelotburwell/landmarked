// Which Instagram posts still need rendering, from today on in data/social.json.
//   node scripts/social-pending.mjs          carousels without both images in public/social/
//                                            or without a caption: two lines for the social
//                                            Action, the building ids, then the post keys
//   node scripts/social-pending.mjs reels    reels without a caption: one JSON array of keys
//                                            (the reels Action renders one per job)
// A post's key is its date for the 08:00 carousel, else <date>-<HHMM> (postKey in lib/plan.mjs).
import { existsSync } from 'node:fs';
import { root, readOr, today, isReel, postKey } from './lib/plan.mjs';

const t = today();
const captioned = new Set(readOr('data/social-captions.json', []).map((c) => c.key ?? c.date));
const posts = readOr('data/social.json', []).filter((p) => p.date >= t);
if (process.argv[2] === 'reels') {
  console.log(JSON.stringify(posts.filter((p) => isReel(p) && !captioned.has(postKey(p))).map(postKey)));
} else {
  const todo = posts.filter((p) => !isReel(p) && (
    !captioned.has(postKey(p)) || ![1, 2].every((n) => existsSync(new URL(`public/social/${postKey(p)}-${n}.jpg`, root)))
  ));
  console.log([...new Set(todo.map((p) => p.id))].join(' '));
  console.log(todo.map(postKey).join(' '));
}
