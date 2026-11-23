import './style.css';
import {
  ROUNDS,
  distanceKm,
  formatKm,
  load,
  msToMidnight,
  points,
  save,
  shareText,
  todayKey,
  formatDay,
  stats,
  loadDay,
  pastDays,
  progress,
  type Building,
  type DayState,
} from './game';
import type { Globe } from './globe';
import { finishAndRank, track, trackOnce } from './track';

// Cesium reads this global to find Workers/Assets; must be set before the engine loads.
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  date: $('date'),
  score: $('score'),
  qnum: $('qnum'),
  clue: $('clue'),
  globe: $('globe'),
  placeholder: $('globe-placeholder'),
  globeStatus: $('globe-status'),
  credits: $('credits'),
  result: $('result'),
  rPoints: $('r-points'),
  rDistance: $('r-distance'),
  rName: $('r-name'),
  rArchitect: $('r-architect'),
  rYear: $('r-year'),
  rCity: $('r-city'),
  rPhoto: $('r-photo'),
  rPhotoBox: $('r-photo-box'),
  rImg: $<HTMLImageElement>('r-img'),
  rCredit: $<HTMLAnchorElement>('r-credit'),
  rInfo: $<HTMLButtonElement>('r-info'),
  next: $<HTMLButtonElement>('next-btn'),
  resultsBtn: $<HTMLButtonElement>('results-btn'),
  intro: $('intro'),
  play: $<HTMLButtonElement>('play-btn'),
  help: $('help'),
  menu: $<HTMLButtonElement>('menu-btn'),
  end: $('end'),
  endScore: $('end-score'),
  endVerdict: $('end-verdict'),
  endRounds: $('end-rounds'),
  endCards: $('end-cards'),
  shareText: $('share-text'),
  shareBtn: $<HTMLButtonElement>('share-btn'),
  showAll: $<HTMLButtonElement>('showall-btn'),
  countdown: $('countdown'),
  countdownRow: $('countdown-row'),
  pinSheet: $('pin-sheet'),
  lede: document.querySelector('.lede') as HTMLElement,
  introStreak: $('intro-streak'),
  endStats: $('end-stats'),
  endRank: $('end-rank'),
  catchup: $('catchup'),
  toast: $('toast'),
};

// ---------- state ----------
// ?day=YYYY-MM-DD plays one of the last CATCH_UP days (catch-up), so new players
// can play the days they missed. It replaced the random practice round on
// 2026-11-23; old ?practice links land on today's puzzle.
const params = new URLSearchParams(location.search);
const today = todayKey();
const recent = pastDays(today); // newest first
const catchUp = recent.includes(params.get('day') ?? '');
if (!catchUp && (params.has('day') || params.has('practice'))) history.replaceState(null, '', import.meta.env.BASE_URL);
const date = catchUp ? params.get('day')! : today;
// Start fetching Cesium now, in parallel with the day's buildings.
const globeModule = import('./globe');
const buildings: Building[] = await loadDay(date);
const state: DayState = load(date, buildings);
// Finishing a past day now doesn't count toward the streak.
if (catchUp && state.guesses.length < ROUNDS) state.late = true;
save(state); // pin this round's ids right away
const day: Building[] = state.ids.map((id) => buildings.find((b) => b.id === id)!);
let globe: Globe | null = null;
let awaiting = false; // waiting for a guess on the current round
let shownScore = 0;

const total = () => state.guesses.reduce((t, g) => t + g.pts, 0);
const round = () => state.guesses.length; // index of the round being played
// Shared results always name the real site, wherever the game was played.
// A bare domain (no https://) still becomes a link in chat apps.
const SITE = 'landmarked.land';
const shareUrl = () => SITE;

// ---------- static UI ----------
el.date.textContent = catchUp ? `${formatDay(date)} · catch-up` : formatDay(date);
if (catchUp) el.lede.textContent = `Catch up on ${formatDay(date, { weekday: 'long', day: 'numeric', month: 'long' })}. Today's puzzle stays untouched.`;
setScore(total(), false);

renderIntroStreak();
// Anonymous counters: a visit (with the referring site). Catch-up rounds are
// counted under 'practice' on today's date when they start (see the Play button).
if (!catchUp) {
  const ref = (() => { try { return document.referrer ? new URL(document.referrer).hostname : ''; } catch { return ''; } })();
  track('visit', date, ref && ref !== location.hostname ? { ref } : {});
}
if (state.guesses.length >= ROUNDS) {
  el.play.textContent = 'See results';
} else if (state.guesses.length > 0) {
  el.play.textContent = 'Resume';
}

// ---------- globe (loaded in the background) ----------
performance.mark('ui-ready');
const globeReady = globeModule
  .then(({ Globe }) => {
    // Public-domain NASA imagery by default; ?imagery=eox shows Sentinel-2 cloudless for comparison.
    const imagery = new URLSearchParams(location.search).get('imagery') === 'eox' ? 'eox' : 'nasa';
    performance.mark('cesium-loaded');
    const g = new Globe(el.globe, el.credits, imagery);
    // NASA imagery is public domain (credited in How it works); EOX needs its on-screen credit.
    if (imagery === 'eox') el.credits.classList.add('show');
    globe = g;
    g.onClick(onGlobeClick);
    void g.tilesLoaded.then(() => {
      performance.mark('globe-tiles-loaded');
      (window as unknown as { __landmarked: unknown }).__landmarked = { tilesLoaded: performance.now(), globe: g };
    });
    // Let the first frame land before revealing the globe.
    requestAnimationFrame(() => requestAnimationFrame(() => el.placeholder.classList.add('gone')));
    setTimeout(() => (el.placeholder.hidden = true), 800);
    performance.mark('globe-ready');
    return g;
  })
  .catch((err) => {
    console.error(err);
    el.globeStatus.textContent = 'Could not start the 3D globe (WebGL needed). Try another browser.';
    throw err;
  });

// ---------- flow ----------
el.play.addEventListener('click', () => {
  el.intro.hidden = true;
  if (catchUp && round() === 0) track('practice', today);
  if (!catchUp && round() === 0) {
    // Returning player, and back after finishing yesterday: the numbers that show whether people come back.
    const before = stats(today);
    trackOnce('start', date, { returning: before.played > 0, yesterday: before.streak > 0 });
  }
  if (round() >= ROUNDS) {
    showEnd();
    el.resultsBtn.hidden = false;
  } else {
    showQuestion();
  }
});

function showQuestion() {
  const i = round();
  const b = day[i];
  el.qnum.textContent = `QUESTION ${i + 1} OF ${ROUNDS}`;
  el.clue.textContent = b.clue;
  // Preload the photo while the player reads the clue, so the result card shows it instantly.
  if (creditMap[b.id]) new Image().src = photoUrl(b.id);
  el.result.hidden = true;
  awaiting = true;
  if (!globe) el.globeStatus.textContent = 'Loading globe…';
}

function onGlobeClick(lon: number, lat: number) {
  if (awaiting) lockIn(lon, lat);
}

function lockIn(lon: number, lat: number) {
  const i = round();
  const b = day[i];
  const km = distanceKm(lon, lat, b.lon, b.lat);
  const pts = points(km);
  awaiting = false;
  state.guesses.push({ lon: +lon.toFixed(4), lat: +lat.toFixed(4), km: +km.toFixed(2), pts });
  save(state);
  showResultCard(b, km, pts, i);
  // How much of the stage the card covers, so the camera frames the pair above it.
  const stage = el.globe.getBoundingClientRect();
  const card = el.result.getBoundingClientRect();
  const fullWidth = card.width > stage.width * 0.6;
  const inset = fullWidth ? Math.min(0.6, (stage.bottom - card.top) / stage.height) : 0;
  globe?.showResult({ lon: b.lon, lat: b.lat, name: b.name, color: ACCENT, guess: { lon, lat } }, inset);
  setScore(total(), true);
}

function showResultCard(b: Building, km: number, pts: number, i: number) {
  el.rPoints.textContent = String(pts);
  el.rDistance.textContent = formatKm(km);
  el.rName.textContent = b.name;
  el.rArchitect.textContent = b.architect;
  el.rYear.textContent = b.year;
  el.rCity.textContent = `${b.city}, ${b.country}`;
  // The building's photo, whole (never cropped), on a blurred copy of itself.
  const c = creditMap[b.id];
  el.rPhoto.hidden = !c;
  if (c) {
    const src = photoUrl(b.id);
    el.rImg.src = src;
    el.rImg.alt = b.name;
    el.rPhotoBox.style.setProperty('--photo', `url("${src}")`);
    el.rCredit.textContent = `Photo: ${c.artist}, ${c.license}`;
    el.rCredit.href = c.page;
  }
  setCreditShown(false);
  el.next.textContent = i + 1 >= ROUNDS ? 'See results' : 'Next';
  el.result.hidden = false;
  el.next.focus({ preventScroll: true });
}

// The photo credit (required by the licences) stays out of the way behind a small "i".
function setCreditShown(on: boolean) {
  el.rPhoto.classList.toggle('credit-on', on);
  el.rInfo.setAttribute('aria-expanded', String(on));
}
el.rInfo.addEventListener('click', () => setCreditShown(!el.rPhoto.classList.contains('credit-on')));

el.next.addEventListener('click', () => {
  el.result.hidden = true;
  globe?.clear();
  globe?.flyHome();
  if (round() >= ROUNDS) {
    showEnd();
    el.resultsBtn.hidden = false;
  } else {
    showQuestion();
  }
});

// ---------- score ----------
function setScore(to: number, animate: boolean) {
  const from = shownScore;
  shownScore = to;
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.score.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const dur = 900;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.score.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The day goes from easy to hard without saying so (user's choice, 2026-11-23):
// no tier names or difficulty meter, one accent colour throughout.
const ACCENT = '#e3b261';

// ---------- end screen ----------
interface PhotoCredit { v?: string; w: number; h: number; artist: string; license: string; licenseUrl: string | null; page: string }
let credits: Promise<Record<string, PhotoCredit>> | null = null;
const loadCredits = () =>
  (credits ??= fetch(`${import.meta.env.BASE_URL}photos.json`)
    .then((r): Promise<Record<string, PhotoCredit>> => (r.ok ? r.json() : Promise.resolve({})))
    .catch((): Record<string, PhotoCredit> => ({})));
// Photo credits, loaded early so the result card can show the photo at once.
let creditMap: Record<string, PhotoCredit> = {};
void loadCredits().then((c) => (creditMap = c));
// photos.json (written on every build) gives each photo a content hash, so a replaced
// photo gets a new URL and never comes from an old browser or service-worker cache.
const photoUrl = (id: string) => `${import.meta.env.BASE_URL}photos/${id}.jpg${creditMap[id]?.v ? `?v=${creditMap[id].v}` : ''}`;

function verdict(score: number): string {
  if (score >= 900) return 'Master builder. You could find these blindfolded.';
  if (score >= 750) return 'Seasoned traveller. Nearly a perfect itinerary.';
  if (score >= 550) return 'Good eye. A few wrong turns, but you got around.';
  if (score >= 350) return 'Getting your bearings. The map is starting to fill in.';
  return 'Lost in the lobby. Tomorrow is a new blueprint.';
}

// ---------- streaks and stats (this device only; catch-up days don't extend streaks) ----------
function renderIntroStreak() {
  if (catchUp) return;
  const s = stats(today);
  if (!s.streak) return;
  const done = state.guesses.length >= ROUNDS;
  el.introStreak.textContent = `🔥 ${s.streak}-day streak${done ? '' : '. Play today to keep it going.'}`;
  el.introStreak.hidden = false;
}
/** "You beat 72% of today's players", once enough people have finished. */
async function renderRank() {
  if (catchUp) return;
  const r = await finishAndRank(date, total());
  if (!r || r.players < 20) return;
  el.endRank.textContent = r.beat >= 1 ? `You beat ${r.beat}% of today's players` : `${r.players.toLocaleString('en-US')} players so far today`;
  el.endRank.hidden = false;
}
function renderStats() {
  const s = stats(today);
  const cell = (value: string | number, label: string) => {
    const c = h('div', 'stat');
    c.append(h('b', '', String(value)), h('span', '', label));
    return c;
  };
  const row = h('div', 'stat-row');
  row.append(cell(s.played, 'Played'), cell(s.streak ? `🔥 ${s.streak}` : 0, 'Streak'), cell(s.bestStreak, 'Best streak'), cell(s.average, 'Average'));
  // Score spread, best band on top; today's band highlighted.
  const bands = h('div', 'bands');
  const max = Math.max(1, ...s.bands);
  const mine = Math.min(4, Math.floor(total() / 200));
  for (let i = 4; i >= 0; i--) {
    const line = h('div', `band${i === mine ? ' mine' : ''}`);
    const track = h('span', 'band-track');
    const fill = h('i');
    fill.style.width = `${Math.max(s.bands[i] ? 6 : 0, (s.bands[i] / max) * 100)}%`;
    track.append(fill);
    line.append(h('span', 'band-label', i === 4 ? '800+' : `${i * 200}–${i * 200 + 199}`), track, h('span', 'band-n', String(s.bands[i])));
    bands.append(line);
  }
  el.endStats.replaceChildren(row, bands);
  el.endStats.hidden = false;
}

/** Small DOM helper: element with class and text (never innerHTML). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function showEnd() {
  awaiting = false;
  el.qnum.textContent = catchUp ? 'CATCH-UP DONE' : 'DONE FOR TODAY';
  el.clue.textContent = catchUp
    ? `You scored ${total()} of 1000. Tap a building on the globe to read about it.`
    : `You scored ${total()} of 1000. Tap a building on the globe to read about it, and come back tomorrow for five more.`;
  el.endScore.textContent = String(total());
  el.endVerdict.textContent = verdict(total());
  renderStats();
  void renderRank();
  renderCatchUp();

  // Results breakdown: one row per round.
  el.endRounds.replaceChildren();
  state.guesses.forEach((g, i) => {
    const b = day[i];
    const li = h('li', 'round');
    const pts = h('span', 'r-pts', String(g.pts));
    const track = h('span', 'r-track');
    const fill = h('i');
    track.append(fill);
    li.append(h('span', 'r-num', String(i + 1)), h('span', 'r-name', b.name), pts, track, h('span', 'r-dist', formatKm(g.km)));
    el.endRounds.append(li);
    requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${Math.max(2, (g.pts / 200) * 100)}%`)));
  });

  // One card per building, with a photo and a fun description.
  void loadCredits().then((cr) => {
    el.endCards.replaceChildren(...state.guesses.map((_, i) => buildingCard(i, cr)));
  });
  // The day's buildings stay pinned to the globe behind the results.
  void showPins();

  el.shareText.textContent = shareText(state, shareUrl());
  el.end.hidden = false;
  el.end.scrollTop = 0;
  tickCountdown();
}

function buildingCard(i: number, cr: Record<string, PhotoCredit>): HTMLElement {
        const g = state.guesses[i];
        const b = day[i];
        const card = h('article', 'bcard');
        const c = cr[b.id];
        if (c) {
          const fig = h('figure', 'bphoto');
          const img = h('img');
          img.src = photoUrl(b.id);
          img.alt = b.name;
          img.loading = 'lazy';
          img.width = c.w;
          img.height = c.h;
          const cap = h('figcaption');
          const link = h('a', '', `Photo: ${c.artist}, ${c.license}`);
          link.href = c.page;
          link.target = '_blank';
          link.rel = 'noopener';
          cap.append(link);
          // Same barely visible "i" as the result card; it toggles the credit.
          const info = h('button', 'rphoto-info');
          info.type = 'button';
          info.setAttribute('aria-label', 'Photo credit');
          info.setAttribute('aria-expanded', 'false');
          info.addEventListener('click', () => {
            const on = fig.classList.toggle('credit-on');
            info.setAttribute('aria-expanded', String(on));
          });
          fig.append(img, cap, info);
          card.append(fig);
        }
        const body = h('div', 'bbody');
        const top = h('div', 'btop');
        top.append(h('span', 'bres', `${g.pts} pts · ${formatKm(g.km)}`));
        body.append(top, h('h4', '', b.name), h('p', 'bmeta', `${b.architect} · ${b.year} · ${b.city}, ${b.country}`), h('p', 'bblurb', b.blurb ?? ''));
        card.append(body);
        return card;
}

/** Flags, guesses and photo chips for every building played today, on the globe. */
async function showPins() {
  const g = globe ?? (await globeReady);
  const cr = await loadCredits();
  g.onPinClick(openPin);
  g.showAll(
    state.guesses.map((guess, i) => {
      const b = day[i];
      return {
        id: b.id,
        lon: b.lon,
        lat: b.lat,
        name: b.name,
        color: ACCENT,
        guess,
        photo: cr[b.id] ? photoUrl(b.id) : undefined,
      };
    }),
  );
}

/** Opens a building's card over the globe (tapping its chip). */
async function openPin(id: string) {
  const i = day.findIndex((b) => b.id === id);
  if (i < 0 || !state.guesses[i]) return;
  const cr = await loadCredits();
  const close = h('button', 'icon-btn close', '✕');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => (el.pinSheet.hidden = true));
  el.pinSheet.replaceChildren(close, buildingCard(i, cr));
  el.pinSheet.hidden = false;
  el.pinSheet.scrollTop = 0;
  const stage = el.globe.getBoundingClientRect();
  const sheet = el.pinSheet.getBoundingClientRect();
  const inset = sheet.width > stage.width * 0.6 ? Math.min(0.7, (stage.bottom - sheet.top) / stage.height) : 0;
  globe?.focus(day[i].lon, day[i].lat, inset);
}

el.shareBtn.addEventListener('click', async () => {
  if (!catchUp) track('share', date);
  const text = shareText(state, shareUrl());
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    // Fallback: select the text so the player can copy it by hand.
    const r = document.createRange();
    r.selectNodeContents(el.shareText);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
  }
});

el.showAll.addEventListener('click', async () => {
  el.end.hidden = true;
  (globe ?? (await globeReady)).flyHome();
});

el.resultsBtn.addEventListener('click', () => showEnd());

/** The last five days, oldest first: each shows its score, or invites you to play it. */
function renderCatchUp() {
  const row = h('div', 'cdays');
  for (const d of [...recent].reverse()) {
    const p = progress(d);
    const a = h('a', `cday${d === date ? ' cur' : ''}`);
    a.href = `?day=${d}`;
    a.append(
      h('span', 'cday-name', formatDay(d, { weekday: 'short' })),
      h('span', 'cday-score', !p ? 'Play' : p.guesses >= ROUNDS ? String(p.total) : 'Resume'),
    );
    row.append(a);
  }
  el.catchup.replaceChildren(h('div', 'cdays-label', 'Catch up on the last 5 days'), row);
  el.catchup.hidden = false;
}

let countdownTimer = 0;
function tickCountdown() {
  clearTimeout(countdownTimer);
  if (catchUp) {
    const back = h('a', '', "Back to today's buildings");
    back.href = import.meta.env.BASE_URL;
    el.countdownRow.replaceChildren(back);
    return;
  }
  const ms = msToMidnight();
  if (ms < 1000 || todayKey() !== date) {
    location.reload();
    return;
  }
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  el.countdown.textContent = `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  countdownTimer = window.setTimeout(tickCountdown, 1000 - (Date.now() % 1000));
}

// ---------- dialogs ----------
el.menu.addEventListener('click', () => (el.help.hidden = false));
for (const o of [el.help, el.end]) {
  o.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === o || t.closest('[data-close]')) o.hidden = true;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.help.hidden = true;
    el.end.hidden = true;
  }
  if (e.key === 'Enter' && !el.result.hidden && document.activeElement !== el.next) el.next.click();
});

let toastTimer = 0;
function toast(msg: string) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 1600);
}

// ---------- offline cache ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined));
}

