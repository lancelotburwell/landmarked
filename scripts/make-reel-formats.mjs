// Ten more Instagram reel formats (prototypes, 2026-11-24), beside the two fixed templates
// in make-reel.mjs. Each one is a different way to get a comment, a rewatch or a share;
// none shows the answer (it is in the .txt notes, for replying to comments). Silent: add
// trending audio in Instagram (the .txt suggests a mood); never music that matches the place.
//
//   zoomout    a macro detail slowly widens with a seconds counter; stops before it gives
//              the building away. Comment the second you got it.
//   ladder     three clues, hardest first, worth 3, 2 and 1 points. Comment points + guess.
//   pins       one clue, four numbered pins on the globe. Comment 1–4 (the game in 10 s).
//   blueprint  the building's edges traced from a photo and drawn in gold on a blueprint
//              grid, from the ground up. Comment the name.
//   emoji      three landmarks as emoji riddles. Comment 1… 2… 3…
//   lie        two truths and a lie about a named building. Comment A, B or C.
//   timeline   four named buildings: oldest to newest? Comment the order (e.g. BADC).
//   stop       the globe sweeps under a crosshair: pause when it's on the building. Every
//              rewatch is a retry. Comment where you stopped.
//   pick       four places as strips: one free flight, where to? No wrong answer; tag a friend.
//   speed      five close-ups, two seconds each. Comment your score x/5.
//
//   npm run build && npx vite preview --port 4173, then
//   GPU=1 node scripts/make-reel-formats.mjs <format> [url]
// Options: AT=1,3,6.6 (only those moments, as PNGs in social/reels/.frames-<format>/),
// REELS_TO=<folder> (copy for the phone; default G:/My Drive/Landmarked reels, REELS_TO= skips).
// The content of each format (buildings, crops, clues, captions) is in FORMATS below:
// edit it there for the next one. Only use buildings whose day has been played.
// Photos: social/src/<id>.jpg from scripts/social-photos.mjs (a <id>-reel.jpg wins).
// Writes social/reels/<format>-<first building id>.mp4 and .txt.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const B = read('data/buildings.json');
const bld = (id) => B.find((b) => b.id === id) ?? (() => { throw new Error(`no building ${id}`); })();

// ---------- photos and credits ----------
const photoFile = (id) => (existsSync(new URL(`social/src/${id}-reel.jpg`, root)) ? `social/src/${id}-reel.jpg` : `social/src/${id}.jpg`);
const photo = (id) => {
  const f = photoFile(id);
  if (!existsSync(new URL(f, root))) { console.error(`run node scripts/social-photos.mjs ${id} first`); process.exit(1); }
  return `data:image/jpeg;base64,${readFileSync(new URL(f, root)).toString('base64')}`;
};
// "📷 artist · licence · cropped · Wikimedia Commons" (public domain: just Wikimedia Commons).
function credit(id, how = 'cropped') {
  let artist, license;
  if (photoFile(id).endsWith('-reel.jpg')) ({ artist, license } = read(`social/src/${id}-reel.json`));
  else {
    const c = read('public/photos/credits.json')[id];
    artist = c.artist.replace(/^No machine-readable author provided\.\s*(.+?) assumed.*$/, '$1')
      .replace(/\S+\.jpe?g:\s*/gi, '').replace(/\s*\(talk\)/g, '').trim(); // "File.jpg: X; derivative work: Y (talk)"
    license = c.license;
  }
  return /^(cc0|pd|public domain)/i.test(license) ? '📷 Wikimedia Commons' : `📷 ${artist} · ${license} · ${how} · Wikimedia Commons`;
}
const SQUARE = { easy: '🟩', medium: '🟨', hard: '🟥' };

// ---------- the ten formats ----------
// cfg() builds what the page draws; caption: hook (one fact or tease, no names when the
// building is the answer), question, credits; notes: the answer and tips, for the user only.
const FORMATS = {
  zoomout: {
    ids: ['sagrada-familia'],
    cfg: () => ({ photo: photo('sagrada-familia'), from: [0.555, 0.13, 0.085], to: [0.5, 0.5, 0.37],
      hook: 'Name it before I zoom out', cta: 'Comment the second you got it 👇' }),
    hook: 'Construction started in 1882, and it still isn\'t finished. How many seconds do you need?',
    question: 'Name it. Comment the second you got it 👇',
    answer: 'Sagrada Família, Barcelona.',
    mood: 'slow build, rising synth or a ticking beat; no Spanish guitar',
  },
  ladder: {
    ids: ['pantheon'],
    cfg: () => ({ hook: '3 clues. Get it sooner, score more.', points: ['3 POINTS', '2 POINTS', '1 POINT'],
      clues: [
        'The name carved across its front belongs to the man who built an earlier temple on this spot, not the emperor who built this one.',
        'Its concrete gets lighter towards the top, mixed with volcanic pumice, and it has been a church since the year 609.',
        'A porch of granite columns, and an open eye at the top of the dome that lets the rain fall straight onto the floor.',
      ],
      cta: 'Comment your points + your guess 👇' }),
    hook: 'Almost 2,000 years old and still the largest unreinforced concrete dome on Earth.',
    question: 'How many points did you get? Comment your score + your guess 👇',
    answer: 'The Pantheon, Rome.',
    mood: 'quiz-show tension, three beats that match the three clues (0.9 s, 4.8 s, 8.7 s)',
  },
  pins: {
    ids: ['great-mosque-djenne'],
    cfg: () => {
      const b = bld('great-mosque-djenne');
      // Decoys: other places along the Sahel and the Gulf of Guinea, about 1,000–1,400 km away.
      return { hook: 'Which pin is it?', clue: b.clues[0], cta: 'Comment 1, 2, 3 or 4 👇',
        pins: [{ lat: 14.6, lon: -16.2 }, { lat: 6.8, lon: -1.6 }, { lat: b.lat, lon: b.lon }, { lat: 16.9, lon: 7.9 }] };
    },
    hook: 'The wooden sticks poking out of its walls are built-in scaffolding. Which pin is it?',
    question: 'One clue, four pins. Comment 1, 2, 3 or 4 👇',
    answer: 'Pin 3: the Great Mosque of Djenné, Mali. (1 = Senegal coast, 2 = central Ghana, 4 = central Niger: decoys only.)',
    mood: 'warm, minimal percussion; no West African music (it would be a clue)',
  },
  blueprint: {
    ids: ['big-ben'],
    cfg: () => ({ photo: photo('big-ben'), crop: [0.25, 0.03, 0.75, 0.94], keep: 0.2,
      hook: 'Name it from the blueprint', cta: 'Comment the name 👇' }),
    hook: 'Its great bell cracked, so it has rung slightly out of tune ever since. Name it from the drawing.',
    question: 'Name it from the blueprint. Comment the name 👇',
    answer: 'Big Ben (the Elizabeth Tower), London.',
    credits: () => [credit('big-ben', 'edges traced')],
    mood: 'lo-fi, pencil-on-paper calm; no British anthem-like music',
  },
  emoji: {
    ids: ['leaning-tower-pisa', 'notre-dame', 'st-basils'],
    cfg: () => ({ hook: 'Name all 3 landmarks', riddles: ['🗼↘️🤳🍕', '🔔🔥🥐⛪', '🧅🧅🍭❄️'], cta: 'Comment 1… 2… 3… 👇' }),
    hook: 'Three famous landmarks, told only in emoji. Can you get all three?',
    question: 'Comment your answers: 1… 2… 3… 👇',
    answer: '1 Leaning Tower of Pisa (tilting tower, the "holding it up" selfie, pizza). 2 Notre-Dame de Paris (bells, the 2019 fire, croissant). 3 St Basil\'s Cathedral, Moscow (onion domes, candy colours, snow).',
    credits: () => [],
    mood: 'playful, bouncy pop; three beats for the three rows',
  },
  lie: {
    ids: ['colosseum'],
    cfg: () => ({ photo: photo('colosseum'), focus: [0.5, 0.55], name: 'Colosseum, Rome', hook: 'Two truths, one lie',
      statements: [
        'Sailors worked a giant canvas awning that shaded the crowd.',
        'Not one stone has been taken away since the Romans finished it.',
        'Lifts hoisted wild animals up through trapdoors in the arena floor.',
      ],
      cta: 'The lie? Comment A, B or C 👇' }),
    hook: 'Up to 80,000 people came here for gladiator fights. One of these facts is made up.',
    question: 'Which is the lie? Comment A, B or C 👇',
    answer: 'B is the lie: after Rome fell it served as a quarry (and a fortress, workshops, housing), which is why so much is missing. A and C are true.',
    mood: 'suspense, a ticking or pizzicato bed',
  },
  timeline: {
    ids: ['st-basils', 'potala-palace', 'notre-dame', 'leaning-tower-pisa'],
    cfg: () => ({ hook: 'Oldest to newest?', sub: 'By the year each was finished.', cta: 'Comment the order, like BADC 👇',
      items: [
        { name: "St Basil's", photo: photo('st-basils'), focus: [0.5, 0.45] },
        { name: 'Potala Palace', photo: photo('potala-palace') },
        { name: 'Notre-Dame', photo: photo('notre-dame'), focus: [0.5, 0.4] },
        { name: 'Pisa tower', photo: photo('leaning-tower-pisa'), focus: [0.5, 0.35] },
      ] }),
    hook: 'Four landmarks, four centuries. Which one was finished first?',
    question: 'Oldest to newest: comment the order, like BADC 👇',
    answer: 'CDAB: Notre-Dame (largely finished by 1260, completed 1345), Pisa tower (1372), St Basil\'s (1561), Potala Palace (1649).',
    mood: 'clock-like, steady beat',
  },
  stop: {
    ids: ['elbphilharmonie'],
    cfg: () => { const b = bld('elbphilharmonie'); return { lon: b.lon, lat: b.lat, at: 7.3, clue: b.clues[0], hook: 'Pause when the crosshair is on it', cta: 'Comment where you stopped 👇' }; },
    hook: 'Its budget grew to about ten times the plan. Can you stop the globe on it?',
    question: 'Pause the video when the crosshair is on it. Comment where you stopped 👇',
    answer: 'The Elbphilharmonie, Hamburg (Germany). The crosshair passes over it at 7.3 s.',
    mood: 'fast, driving electronic; the spin is the rhythm',
  },
  pick: {
    ids: ['fallingwater', 'marina-bay-sands', 'taj-mahal', 'hallgrimskirkja'],
    cfg: () => ({ hook: 'One free flight tomorrow. Where to?', cta: "Comment A–D, tag who's coming 👇",
      items: [
        { label: 'Fallingwater, USA', photo: photo('fallingwater') },
        { label: 'Marina Bay Sands, Singapore', photo: photo('marina-bay-sands'), focus: [0.5, 0.45] },
        { label: 'Taj Mahal, India', photo: photo('taj-mahal'), focus: [0.5, 0.45] },
        { label: 'Hallgrímskirkja, Iceland', photo: photo('hallgrimskirkja'), focus: [0.5, 0.62] },
      ] }),
    hook: 'No wrong answers. Pick one, then tag who you\'re taking.',
    question: "Comment A, B, C or D, and tag who's coming 👇",
    answer: 'No answer: an opinion poll. Reply to comments with a fact about the building they picked.',
    mood: 'dreamy travel / wanderlust; any trending audio works',
  },
  speed: {
    ids: ['petronas-towers', 'chrysler-building', 'cn-tower', 'leaning-tower-pisa', 'eiffel-tower'],
    cfg: () => ({ hook: '5 landmarks. 2 seconds each.', cta: 'Comment your score: x/5 👇',
      shots: [
        { photo: photo('petronas-towers'), crop: [0.5, 0.45, 0.45] },
        { photo: photo('chrysler-building'), crop: [0.52, 0.17, 0.55] },
        { photo: photo('cn-tower'), crop: [0.5, 0.37, 0.35] },
        { photo: photo('leaning-tower-pisa'), crop: [0.5, 0.15, 0.55] },
        { photo: photo('eiffel-tower'), crop: [0.5, 0.62, 0.42] },
      ] }),
    hook: 'Five famous landmarks, two seconds each. No pausing.',
    question: 'How many did you get? Comment your score: x/5 👇',
    answer: '1 Petronas Towers (Kuala Lumpur), 2 Chrysler Building (New York), 3 CN Tower (Toronto), 4 Leaning Tower of Pisa, 5 Eiffel Tower (Paris).',
    mood: 'fast beat with a hit every 2 s (cuts at 0, 2, 4, 6, 8 s)',
  },
};

const [name, url = 'http://localhost:4173/'] = process.argv.slice(2);
const FMT = FORMATS[name];
if (!FMT) { console.error(`usage: node scripts/make-reel-formats.mjs <${Object.keys(FORMATS).join('|')}> [url]`); process.exit(1); }
const cfg = FMT.cfg();
const font = (w) => readFileSync(new URL(`node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${w}-normal.woff2`, root)).toString('base64');

const FPS = 30, W = 1080, H = 1920;
const frames = path(`social/reels/.frames-${name}/`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: process.env.GPU
    ? ['--ignore-gpu-blocklist', '--enable-webgl', '--enable-gpu', '--use-angle=default']
    : ['--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page:', e.message));
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__landmarked?.globe, { timeout: 90_000 });
await page.addScriptTag({ path: path('scripts/reel-page.js') });
const { total, globe } = await page.evaluate((n, c, f) => window.__reel.setup(n, c, f), name, cfg, { regular: font(400), semi: font(600) });

const n = Math.round(total * FPS);
console.log(`${name}: ${total} s, ${n} frames`);
const only = process.env.AT ? process.env.AT.split(',').map((x) => Math.min(n - 1, Math.round(Number(x) * FPS))) : null;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  await page.evaluate((t) => window.__reel.frame(t), i / FPS);
  if (globe) {
    await page.waitForFunction(() => {
      const s = window.__landmarked.globe.widget.scene;
      s.requestRender(); s.render();
      return s.globe.tilesLoaded;
    }, { timeout: 60_000, polling: 50 }).catch(() => console.warn(`frame ${i}: tiles still loading`));
  }
  await page.screenshot({ path: `${frames}${String(i).padStart(4, '0')}.png` });
  if (i % 60 === 0) console.log(`  ${i}/${n} frames, ${Math.round((Date.now() - t0) / 1000)} s`);
}
await browser.close();
if (only) { console.log(`frames in social/reels/.frames-${name}/`); process.exit(0); }

const base = `social/reels/${name}-${FMT.ids[0]}`;
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}%04d.png`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path(`${base}.mp4`)]);
rmSync(frames, { recursive: true, force: true });

// ---------- caption ----------
const square = FMT.ids.length === 1 ? SQUARE[bld(FMT.ids[0]).tier] ?? '' : '';
const credits = FMT.credits ? FMT.credits() : FMT.ids.filter((id) => ['zoomout', 'lie', 'timeline', 'pick', 'speed'].includes(name)).map((id) => credit(id));
const caption = [
  FMT.hook, '',
  `${FMT.question} ${square}`.trim(),
  'Play at landmarked.land (link in bio)', '',
  '#architecture #geography #dailypuzzle #guessthebuilding',
  ...(credits.length ? ['', ...new Set(credits)] : []),
].join('\n');
const notes = [
  '--- notes, not part of the caption ---',
  `Format: ${name}. Answer: ${FMT.answer}`,
  'Reply to guesses without giving it away ("so close!", "right continent").',
  `Music (optional, trending audio helps reach): ${FMT.mood}. Never a song that matches the place.`,
  'No location tag: Instagram shows it above the video.',
].join('\n');
writeFileSync(path(`${base}.txt`), caption + '\n\n' + notes + '\n');
console.log(`wrote ${base}.mp4 and .txt`);

const to = process.env.REELS_TO ?? (existsSync('G:/My Drive') ? 'G:/My Drive/Landmarked reels' : '');
if (to) {
  mkdirSync(to, { recursive: true });
  for (const ext of ['mp4', 'txt']) copyFileSync(path(`${base}.${ext}`), `${to}/${name}-${FMT.ids[0]}.${ext}`);
  console.log(`copied to ${to}`);
}
