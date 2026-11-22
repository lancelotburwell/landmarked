import './style.css';
import {
  DAY_TIERS,
  ROUNDS,
  TIER_COLOR,
  byId,
  distanceKm,
  formatKm,
  load,
  msToMidnight,
  points,
  save,
  shareText,
  todayKey,
  formatDay,
  peek,
  pickPractice,
  type Building,
  type DayState,
} from './game';
import type { Globe } from './globe';

// Cesium reads this global to find Workers/Assets; must be set before the engine loads.
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  date: $('date'),
  score: $('score'),
  qnum: $('qnum'),
  qtier: $('qtier'),
  dots: $('dots'),
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
  toast: $('toast'),
};

// ---------- state ----------
// ?practice plays a random five (resumes the last practice round);
// ?practice=new deals a fresh one. Today's puzzle is never touched.
const params = new URLSearchParams(location.search);
const today = todayKey();
const practice = params.has('practice');
const date = practice ? 'practice' : today;
const newPractice = (): DayState => ({ date: 'practice', ids: pickPractice().map((b) => b.id), guesses: [] });
if (practice && params.get('practice') === 'new') history.replaceState(null, '', `${import.meta.env.BASE_URL}?practice`);
const state: DayState = practice
  ? (params.get('practice') !== 'new' && peek('practice')) || newPractice()
  : load(date);
save(state); // pin this round's ids right away
const day: Building[] = state.ids.map((id) => byId(id)!);
let globe: Globe | null = null;
let awaiting = false; // waiting for a guess on the current round
let shownScore = 0;

const total = () => state.guesses.reduce((t, g) => t + g.pts, 0);
const round = () => state.guesses.length; // index of the round being played
const shareUrl = () => location.origin + import.meta.env.BASE_URL;

// ---------- static UI ----------
el.date.textContent = practice ? 'Practice round' : formatDay(date);
if (practice) el.lede.textContent = "A random five, just for practice. Today's puzzle stays untouched.";
setScore(total(), false);
renderDots();

if (state.guesses.length >= ROUNDS) {
  el.play.textContent = 'See results';
} else if (state.guesses.length > 0) {
  el.play.textContent = 'Resume';
}

// ---------- globe (loaded in the background) ----------
performance.mark('ui-ready');
const globeReady = import('./globe')
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
  el.qtier.textContent = DAY_TIERS[i].toUpperCase();
  el.qtier.className = `tier ${DAY_TIERS[i]}`;
  el.clue.textContent = b.clue;
  renderDots();
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
  renderDots();
  showResultCard(b, km, pts, i);
  // How much of the stage the card covers, so the camera frames the pair above it.
  const stage = el.globe.getBoundingClientRect();
  const card = el.result.getBoundingClientRect();
  const fullWidth = card.width > stage.width * 0.6;
  const inset = fullWidth ? Math.min(0.6, (stage.bottom - card.top) / stage.height) : 0;
  globe?.showResult({ lon: b.lon, lat: b.lat, name: b.name, color: TIER_COLOR[b.tier], guess: { lon, lat } }, inset);
  setScore(total(), true);
}

function showResultCard(b: Building, km: number, pts: number, i: number) {
  el.rPoints.textContent = String(pts);
  el.rPoints.style.color = TIER_COLOR[b.tier];
  el.rDistance.textContent = formatKm(km);
  el.rName.textContent = b.name;
  el.rArchitect.textContent = b.architect;
  el.rYear.textContent = b.year;
  el.rCity.textContent = `${b.city}, ${b.country}`;
  el.next.textContent = i + 1 >= ROUNDS ? 'See results' : 'Next';
  el.result.hidden = false;
  el.next.focus({ preventScroll: true });
}

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

function renderDots() {
  const dots = el.dots.querySelectorAll('i');
  dots.forEach((d, i) => {
    const g = state.guesses[i];
    d.className = !g && i === round() ? 'cur' : '';
    d.style.background = g ? TIER_COLOR[DAY_TIERS[i]] : '';
    d.style.opacity = g ? String(0.35 + (0.65 * g.pts) / 200) : '';
  });
}

// ---------- end screen ----------
interface PhotoCredit { w: number; h: number; artist: string; license: string; licenseUrl: string | null; page: string }
let credits: Promise<Record<string, PhotoCredit>> | null = null;
const loadCredits = () =>
  (credits ??= fetch(`${import.meta.env.BASE_URL}photos/credits.json`)
    .then((r): Promise<Record<string, PhotoCredit>> => (r.ok ? r.json() : Promise.resolve({})))
    .catch((): Record<string, PhotoCredit> => ({})));

function verdict(score: number): string {
  if (score >= 900) return 'Master builder. You could find these blindfolded.';
  if (score >= 750) return 'Seasoned traveller. Nearly a perfect itinerary.';
  if (score >= 550) return 'Good eye. A few wrong turns, but you got around.';
  if (score >= 350) return 'Getting your bearings. The map is starting to fill in.';
  return 'Lost in the lobby. Tomorrow is a new blueprint.';
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
  el.qnum.textContent = practice ? 'PRACTICE DONE' : 'DONE FOR TODAY';
  el.qtier.textContent = '';
  el.clue.textContent = practice
    ? `You scored ${total()} of 1000. Tap a building on the globe to read about it.`
    : `You scored ${total()} of 1000. Tap a building on the globe to read about it, and come back tomorrow for five more.`;
  renderDots();
  el.endScore.textContent = String(total());
  el.endVerdict.textContent = verdict(total());

  // Results breakdown: one row per round.
  el.endRounds.replaceChildren();
  state.guesses.forEach((g, i) => {
    const b = day[i];
    const li = h('li', 'round');
    const pts = h('span', 'r-pts', String(g.pts));
    pts.style.color = TIER_COLOR[b.tier];
    const track = h('span', 'r-track');
    const fill = h('i');
    fill.style.background = TIER_COLOR[b.tier];
    track.append(fill);
    li.append(h('span', 'r-num', String(i + 1)), h('span', `tier ${b.tier}`, b.tier.toUpperCase()), h('span', 'r-name', b.name), pts, track, h('span', 'r-dist', formatKm(g.km)));
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
          img.src = `${import.meta.env.BASE_URL}photos/${b.id}.jpg`;
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
          fig.append(img, cap);
          card.append(fig);
        }
        const body = h('div', 'bbody');
        const top = h('div', 'btop');
        top.append(h('span', `tier ${b.tier}`, b.tier.toUpperCase()), h('span', 'bres', `${g.pts} pts · ${formatKm(g.km)}`));
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
        color: TIER_COLOR[b.tier],
        guess,
        photo: cr[b.id] ? `${import.meta.env.BASE_URL}photos/${b.id}.jpg` : undefined,
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

let countdownTimer = 0;
function tickCountdown() {
  clearTimeout(countdownTimer);
  if (practice) {
    const again = h('a', '', 'New practice round');
    again.href = '?practice=new';
    const back = h('a', '', "Today's buildings");
    back.href = import.meta.env.BASE_URL;
    el.countdownRow.replaceChildren(again, ' · ', back);
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

