// Fallback filler for the Instagram queue, with no one at the keyboard (user, 2026-11-27: "the
// same automation as i.smell.music"): for every day from tomorrow through today + 8 it adds
// whichever of the four posts (carousels 08:00 and 17:00, reels 12:00 and 20:00) is missing
// from data/social.json. The "Fill Instagram queue" Action runs it every night (started by a
// Vercel timed job, api/instagram.ts ?fill=1), commits, and starts the two render Actions;
// api/instagram.ts then posts each one at its time. Posts written by hand are never touched.
//
//   node scripts/auto-social.mjs [--dry]
//
// Carousels: two of that day's buildings with a photo, not featured in the last 30 days.
//   The photo is a high-resolution file from the building's own Commons category (Wikidata
//   P373), preferring titles that sound like a detail; else the game photo's original. The
//   crop is "auto": make-social.mjs picks the most detailed 4:5 window, at least 1,080 px of
//   the source. The teaser is a sentence of the blurb that names nothing (see teaser()).
// Reels: a rotation of game formats that need no hand work (who, pins, stop, distance,
//   wordsearch), each showing the globe and never the answer, only with buildings played
//   before the post's date, preferring ones that don't come back as a puzzle within 30 days
//   and weren't reeled in the last 60.
import { writeFileSync } from 'node:fs';
import { root, read, readOr, addDays, dayNum, distanceKm, isReel, postKey, postTime, POST_SLOTS, FROZEN_DAYS } from './lib/plan.mjs';

const DRY = process.argv.includes('--dry');
// Reels only by default: carousels need eyes on the photo, which Claude in the Action has and this
// script doesn't (2026-11-27: its picks showed whole façades and once the wrong building).
// --carousels tries anyway (detail-titled Commons files, else the game photo cropped tight).
const CAROUSELS = process.argv.includes('--carousels');
const UA = { 'User-Agent': 'landmarked-social/1.0 (https://landmarked.land; automated Instagram posts)' };
const B = read('data/buildings.json');
const byId = new Map(B.map((b) => [b.id, b]));
const schedule = read('data/schedule.json');
const byDate = new Map(schedule.map((d) => [d.date, d]));
const credits = read('public/photos/credits.json');
const social = readOr('data/social.json', []);

// Zurich date and time: the posts' clock.
const zurich = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
const now = zurich();
const soon = zurich(new Date(Date.now() + 3 * 3600_000)); // slots closer than 3 h are skipped (rendering takes a while)

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(host, params) {
  for (let i = 0; ; i++) {
    const res = await fetch(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA });
    if (res.ok) return res.json();
    if (i >= 5) throw new Error(`${host} answered ${res.status}`);
    await sleep(10_000 * (i + 1)); // Wikimedia rate limits
  }
}
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const pick = (arr, seed) => arr[hash(seed) % arr.length];
const lastShownClue = (id, before) => {
  const d = schedule.filter((x) => x.date < before && x.ids.includes(id)).at(-1);
  const b = byId.get(id);
  return b.clues[((d?.clues?.[d.ids.indexOf(id)]) ?? 0) % b.clues.length];
};
const playedBefore = (id, date) => schedule.some((d) => d.date < date && d.ids.includes(id));
const returnsWithin = (id, date, days) => schedule.some((d) => d.date >= date && d.date <= addDays(date, days) && d.ids.includes(id));
const usedLines = new Set(social.map((p) => p.line).filter(Boolean));

// ---------- teasers: a sentence of the blurb that gives nothing away ----------
// Rejected: any sentence with a proper noun (a capitalised word after the first, except a few
// style and heritage words), a number of words outside 8–24, or many words shared with the clue.
const ALLOWED_CAPS = new Set('UNESCO World Heritage Site List Gothic Baroque Renaissance Romanesque Rococo Byzantine Roman Romans Greek Neoclassical Modernist Brutalist Art Deco Nouveau Christian Christians Islamic Muslim Buddhist Hindu Catholic Orthodox Jewish Mughal Ottoman AD BC I Christmas Easter Bible God Victorian Tudor Georgian Expo'.split(' '));
const words = (s) => s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
function teaserOptions(b, clue) {
  const banned = new Set([b.name, b.city, b.country, b.architect].flatMap((s) => words(String(s ?? ''))));
  const clueW = new Set(words(clue));
  const sentences = (b.blurb ?? '').match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [];
  const ok = sentences.filter((s) => {
    const n = s.split(/\s+/).length;
    if (n < 8 || n > 24 || usedLines.has(s)) return false;
    const toks = s.split(/\s+/).slice(1).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''));
    if (toks.some((w) => /^[A-Z]/.test(w) && !ALLOWED_CAPS.has(w))) return false;
    if (/^(The|This|These)\s+[A-Z]/.test(s) || /\b(here|this city|the city)\b/i.test(s)) return false;
    const ws = words(s);
    if (ws.some((w) => banned.has(w))) return false;
    const shared = ws.filter((w) => clueW.has(w)).length;
    return shared / Math.max(1, ws.length) < 0.25;
  });
  return ok;
}
const hasTeaser = (b, clue) => teaserOptions(b, clue).length > 0;
function teaser(b, clue, seed) {
  const ok = teaserOptions(b, clue);
  // Prefer sentences with a number or a superlative: they hook better.
  ok.sort((x, y) => Number(/\d|est\b|most\b|first\b|only\b/.test(y)) - Number(/\d|est\b|most\b|first\b|only\b/.test(x)));
  const top = ok.filter((s) => /\d|est\b|most\b|first\b|only\b/.test(s));
  const line = top.length ? pick(top, seed) : ok.length ? pick(ok, seed) : null;
  if (line) usedLines.add(line);
  return line;
}

// ---------- carousel photos: a high-resolution detail from the building's Commons category ----------
// Only files whose title says they show a detail (2026-11-27: taking any photo of the building
// gave whole façades, skylines and street scenes). Searched in the building's category tree
// (Wikidata P373) and, failing that, all of Commons with the building's name in the title.
const DETAIL = /details?|close-?up|closeup|ornament|relief|carving|carved|capital|tiles?|azulejo|mosaic|pattern|texture|ceiling|vault|portal|doors?|lattice|fresco|stucco|frieze|muqarnas|marble|brickwork|cladding|sculpt|decorat|inlay|ironwork|grille|rosette|cornice|corbel|gargoyle|spandrel|tracery|stained glass/i;
const AVOID = /portrait|painting|drawing|engraving|lithograph|map|plan|plaque|sign|inscription|logo|visitor|people|tourist|crowd|night|panorama|aerial|drone|skyline|cityscape|view|seen from|from the|street|sunset|sunrise|by [A-Z]|museum (collection|object)|exhibit|bush|garden|interior with|statue of|bust of|tomb of [A-Z]|text|letter|book|coin|stamp|bridge|pose|photograph|in front|fresco|retrieval|google art project|nara|bestanddeel|rijksmuseum|unsplash| and the |and/i;
// Second tier, when no detail is on Commons: parts of the building (the crop stays tight).
const PART = /fa[cç]ade|window|dome|cupola|column|arch|tower|spire|minaret|gate|wall|roof|entrance|exterior|tympanum|pediment|balcony|steel|glass|concrete|brick|stone|wood/i;
const LICENCE = /^(cc0|cc by(-sa)? [d.]+|public domain|pd)/i;
async function category(qid) {
  if (!qid) return null;
  const j = await api('www.wikidata.org', { action: 'wbgetclaims', entity: qid, property: 'P373' });
  return j.claims?.P373?.[0]?.mainsnak?.datavalue?.value ?? null;
}
async function info(titles) {
  const j = await api('commons.wikimedia.org', { action: 'query', prop: 'imageinfo', iiprop: 'size|extmetadata', titles: titles.join('|') });
  return Object.values(j.query?.pages ?? {}).map((p) => ({ title: p.title, ...(p.imageinfo?.[0] ?? {}) })).filter((x) => x.width);
}
async function search(q) {
  const j = await api('commons.wikimedia.org', { action: 'query', list: 'search', srnamespace: '6', srlimit: '100', srsearch: q }).catch(() => null);
  return (j?.query?.search ?? []).map((r) => r.title);
}
const COMMON = new Set('palace tower towers museum cathedral church basilica temple monastery castle mosque house hall building center centre national world trade saint great theatre theater hotel arts opera royal city new old grand central state'.split(' '));
async function closeUp(b, used) {
  const cat = await category(b.qid).catch(() => null);
  // Files from the building's own category are of the building; anything found more widely must
  // name it (a distinctive word of its name) in the title: deep categories hold museum collections.
  const own = words(b.name).filter((w) => !COMMON.has(w));
  const named = (t) => own.length > 0 && own.some((w) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(w));
  let titles = cat ? await search(`incategory:"${cat}" filew:>3000`) : [];
  if (cat) titles.push(...(await search(`deepcat:"${cat}" filew:>3000 detail`)).filter(named));
  titles.push(...(await search(`"${b.name.replace(/s*(.*)$/, '')}" detail filew:>3000`)).filter(named));
  titles = [...new Set(titles)].filter((t) => /.jpe?g$/i.test(t) && (DETAIL.test(t) || PART.test(t)) && !AVOID.test(t.replace(/^File:/, '')) && !used.has(t));
  const cands = [];
  for (let i = 0; i < titles.length && i < 120; i += 40) cands.push(...await info(titles.slice(i, i + 40)));
  const good = cands.filter((c) => { const l = c.extmetadata?.LicenseShortName?.value ?? ''; return LICENCE.test(l) && !/nc|nd/i.test(l) && c.width >= 3000 && c.height >= 2000; });
  // 1. A file whose title says it's a detail.
  const detail = good.filter((c) => DETAIL.test(c.title)).sort((x, y) => y.width - x.width);
  if (detail.length) return pick(detail.slice(0, 3), b.id + time()).title;
  // 2. The game's own photo (chosen by hand, it shows the building well) at full size, cropped tight.
  const page = credits[b.id]?.page;
  if (page) {
    const file = decodeURIComponent(page.split('/wiki/')[1]).replace(/_/g, ' ');
    const [orig] = await info([file]).catch(() => []);
    if (orig?.width >= 3000 && !used.has(file)) return file;
  }
  // 3. Another photo of a part of the building.
  const part = good.filter((c) => PART.test(c.title)).sort((x, y) => y.width - x.width);
  return part.length ? pick(part.slice(0, 3), b.id + time()).title : null;
}
let clock = 0; const time = () => String(clock++);

const GENERIC_REEL = ['One clue is all you get. Think you know where it is?', 'Most people get the region. Can you name the building?', 'You have seen it in photos. Can you place it?'];
const GENERIC_CAROUSEL = ["One of today's five buildings, up close. Where in the world is it?", "A close-up of one of today's buildings. Could you find it on the globe?"];

// ---------- reel formats ----------
const FORMATS = ['who', 'pins', 'stop', 'distance', 'wordsearch'];
const added = [];
const reeledRecently = (id, date) => social.concat(added).some((p) => isReel(p) && dayNum(date) - dayNum(p.date) < 60 && dayNum(date) - dayNum(p.date) > -10 && (p.ids ?? [p.id]).includes(id));
/** Buildings a reel on `date` may show, best first. */
function reelPool(date, taken) {
  const played = B.filter((b) => !b.retired && playedBefore(b.id, date) && !taken.has(b.id));
  const tiers = [
    (b) => !returnsWithin(b.id, date, 30) && !reeledRecently(b.id, date),
    (b) => !returnsWithin(b.id, date, 14) && !reeledRecently(b.id, date),
    (b) => !reeledRecently(b.id, date),
    () => true,
  ];
  for (const t of tiers) { const r = played.filter(t); if (r.length >= 3) return r; }
  return played;
}
const cityWord = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
function wordGrid(N, ws, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32);
  for (let attempt = 0; attempt < 200; attempt++) {
    const g = Array.from({ length: N }, () => Array(N).fill(''));
    const dirs = [[1, 0], [0, 1], [1, 1]];
    const ok = ws.every((w, wi) => {
      for (let tries = 0; tries < 200; tries++) {
        const [dx, dy] = dirs[(wi + tries) % 3];
        const x = Math.floor(rnd() * (N - dx * (w.length - 1))), y = Math.floor(rnd() * (N - dy * (w.length - 1)));
        if ([...w].every((c, i) => !g[y + dy * i][x + dx * i] || g[y + dy * i][x + dx * i] === c)) { [...w].forEach((c, i) => { g[y + dy * i][x + dx * i] = c; }); return true; }
      }
      return false;
    });
    if (ok) { const L = 'ABCDEFGHIJKLMNOPRSTUVWY'; return g.map((row) => row.map((c) => c || L[Math.floor(rnd() * L.length)]).join('')); }
  }
  return null;
}

function makeReel(date, time, format, taken) {
  const seed = `${date}-${time}`;
  const pool = reelPool(date, taken);
  const single = () => { const good = pool.filter((b) => hasTeaser(b, lastShownClue(b.id, date))); const b = pick(good.length ? good : pool, seed); taken.add(b.id); return b; };
  const base = { date, time, kind: 'reel' };
  if (format === 'who') {
    const b = single();
    const line = teaser(b, lastShownClue(b.id, date), seed) ?? pick(GENERIC_REEL, seed);
    return { ...base, template: 'who', id: b.id, line };
  }
  if (format === 'pins') {
    const b = single();
    const clue = lastShownClue(b.id, date);
    const line = teaser(b, clue, seed) ?? pick(GENERIC_REEL, seed);
    // Three decoy cities from the pool, 500–1,800 km away and at least 300 km from each other.
    const decoys = [];
    for (const d of [...B].sort((x, y) => hash(seed + x.id) - hash(seed + y.id))) {
      const km = distanceKm(b, d);
      if (d.city === b.city || km < 500 || km > 1800) continue;
      if (decoys.some((x) => distanceKm(x, d) < 300 || x.city === d.city)) continue;
      decoys.push(d);
      if (decoys.length === 3) break;
    }
    if (!line || decoys.length < 3) return null;
    const at = hash(seed) % 4;
    const pins = decoys.map((d) => ({ lat: d.lat, lon: d.lon, city: d.city }));
    pins.splice(at, 0, { lat: b.lat, lon: b.lon, city: b.city });
    return {
      ...base, format: 'pins', ids: [b.id], line,
      cfg: { hook: 'Which pin is it?', clue, cta: 'Comment 1, 2, 3 or 4 👇', pins: pins.map(({ lat, lon }) => ({ lat, lon })) },
      question: 'One clue, four pins. Comment 1, 2, 3 or 4 👇',
      answer: `Pin ${at + 1}: ${b.name}, ${b.city}. (Decoys: ${pins.map((p, i) => i === at ? null : `${i + 1} = ${p.city}`).filter(Boolean).join(', ')}.)`,
      mood: 'calm, curious; a soft hit as each pin lands',
    };
  }
  if (format === 'stop') {
    const b = single();
    const clue = lastShownClue(b.id, date);
    const line = teaser(b, clue, seed) ?? 'One clue, one spinning globe.';
    return {
      ...base, format: 'stop', ids: [b.id], line: `${line.replace(/[.!]$/, '.')} Can you stop the globe on it?`,
      cfg: { lon: b.lon, lat: b.lat, at: 7.3, clue, hook: 'Pause when the crosshair is on it', cta: 'Comment where you stopped 👇' },
      question: 'Pause the video when the crosshair is on it. Comment where you stopped 👇',
      answer: `${b.name}, ${b.city} (${b.country}). The crosshair passes over it at 7.3 s.`,
      mood: 'fast, driving electronic; the spin is the rhythm',
    };
  }
  if (format === 'distance') {
    const order = [...pool].sort((x, y) => hash(seed + x.id) - hash(seed + y.id));
    for (const a of order) for (const c of order) {
      const km = distanceKm(a, c);
      if (a === c || a.country === c.country || km < 800 || km > 9000) continue;
      taken.add(a.id); taken.add(c.id);
      const short = (b) => b.name.replace(/\s*\(.*\)$/, '');
      return {
        ...base, format: 'distance', ids: [a.id, c.id],
        line: pick(['Straight line, as the crow flies. Closest guess gets a shout-out.', 'No maps, no googling. How far apart are these two?', 'Guess the distance in km. Closest comment wins bragging rights.'], seed),
        cfg: { hook: 'How far apart?', cta: 'Closest guess in km wins 👇', points: [{ name: short(a), lat: a.lat, lon: a.lon }, { name: short(c), lat: c.lat, lon: c.lon, labelBelow: a.lat > c.lat ? false : true }] },
        question: 'How far apart are they? Comment your guess in km 👇',
        answer: `About ${Math.round(km / 10) * 10} km in a straight line (${Math.round(km)} km between the two buildings).`,
        credits: [], mood: 'calm, curious; a soft hit when the line lands (about 4 s)',
      };
    }
    return null;
  }
  if (format === 'wordsearch') {
    const seen = new Set();
    const picks = [];
    for (const b of [...B].filter((x) => playedBefore(x.id, date)).sort((x, y) => hash(seed + x.id) - hash(seed + y.id))) {
      const w = cityWord(b.city);
      if (w.length < 4 || w.length > 9 || seen.has(w)) continue;
      seen.add(w); picks.push(b);
      if (picks.length === 8) break;
    }
    const grid = picks.length === 8 && wordGrid(11, picks.map((b) => cityWord(b.city)), hash(seed));
    if (!grid) return null;
    return {
      ...base, format: 'wordsearch', ids: picks.map((b) => b.id),
      line: pick(['Eight cities are hiding in here. The first one you spot is where you fly next.', 'The first city you see is your next trip. Which one did you get?', 'Look for three seconds. The first city you spot is your next holiday.'], seed),
      cfg: { hook: 'The first city you see is your next trip ✈️', grid, cta: 'Comment the first city you saw 👇' },
      question: 'Comment the first city you saw 👇',
      answer: `Hidden: ${picks.map((b) => cityWord(b.city)).join(', ')} (cities of buildings already played in Landmarked). No wrong answer: reply with that city's building.`,
      credits: [], mood: 'dreamy travel / wanderlust',
    };
  }
  return null;
}

// ---------- fill the gaps ----------
const featured = (id, date) => social.concat(added).some((p) => !isReel(p) && p.id === id && Math.abs(dayNum(date) - dayNum(p.date)) < 30);
const usedPhotos = new Set(social.map((p) => p.photo).filter(Boolean));
for (let i = 1; i <= FROZEN_DAYS; i++) {
  const date = addDays(now.date, i);
  const day = byDate.get(date);
  if (!day) continue;
  const have = new Set(social.concat(added).filter((p) => p.date === date).map(postTime));
  const taken = new Set(social.concat(added).filter((p) => p.date === date).flatMap((p) => p.ids ?? [p.id]));
  for (const time of POST_SLOTS) {
    if (have.has(time)) continue;
    if (date === soon.date && time <= soon.hm) continue; // too close to render in time
    if (time === '08:00' || time === '17:00') {
      if (!CAROUSELS) continue;
      // Carousel: a building of the day, varied rounds, with a photo, not featured in 30 days.
      const cands = day.ids.filter((id) => credits[id] && !taken.has(id) && !featured(id, date));
      const clueOf = (id) => { const b = byId.get(id); return b.clues[(day.clues?.[day.ids.indexOf(id)] ?? 0) % b.clues.length]; };
      const lean = time === '08:00' ? cands : [...cands].reverse(); // 08:00 leans easy, 17:00 leans hard
      const ordered = [...lean.filter((id) => hasTeaser(byId.get(id), clueOf(id))), ...lean.filter((id) => !hasTeaser(byId.get(id), clueOf(id)))];
      let post = null;
      for (const id of ordered) {
        const b = byId.get(id);
        const clue = b.clues[(day.clues?.[day.ids.indexOf(id)] ?? 0) % b.clues.length];
        const line = teaser(b, clue, `${date}-${time}`) ?? pick(GENERIC_CAROUSEL, `${date}-${time}`);
        const photo = await closeUp(b, usedPhotos).catch((e) => { console.warn(`${id}: ${e.message}`); return null; });
        if (!photo) { usedLines.delete(line); continue; }
        usedPhotos.add(photo);
        post = { date, ...(time === '08:00' ? {} : { time }), id, photo, crop: 'auto', line };
        break;
      }
      if (post) { added.push(post); taken.add(post.id); } else console.warn(`${date} ${time}: no carousel possible`);
    } else {
      // Reel: rotate the formats by day and slot, so the week varies.
      const start = (dayNum(date) * 2 + (time === '12:00' ? 0 : 1)) % FORMATS.length;
      let post = null;
      for (let k = 0; k < FORMATS.length && !post; k++) post = makeReel(date, time, FORMATS[(start + k) % FORMATS.length], taken);
      if (post) added.push(post); else console.warn(`${date} ${time}: no reel possible`);
    }
  }
}

for (const p of added) console.log(postKey(p), isReel(p) ? (p.template ?? p.format) : 'carousel', (p.ids ?? [p.id]).join(','), '|', p.line);
if (!added.length) { console.log('The queue is full.'); process.exit(0); }
if (DRY) process.exit(0);
const all = social.concat(added).sort((a, b) => (a.date + postTime(a)).localeCompare(b.date + postTime(b)));
writeFileSync(new URL('data/social.json', root), `[\n${all.map((p) => '  ' + JSON.stringify(p)).join(',\n')}\n]\n`);
console.log(`${added.length} post(s) added to data/social.json`);
