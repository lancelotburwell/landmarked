import './style.css';
import {
  DAY_TIERS,
  ROUNDS,
  TIER_COLOR,
  byId,
  distanceKm,
  formatKm,
  getPref,
  load,
  msToMidnight,
  points,
  save,
  setPref,
  shareText,
  todayKey,
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
  confirm: $<HTMLInputElement>('confirm-toggle'),
  lock: $<HTMLButtonElement>('lock-btn'),
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
  toast: $('toast'),
};

// ---------- state ----------
const date = todayKey();
const state: DayState = load(date);
save(state); // pin today's ids right away
const day: Building[] = state.ids.map((id) => byId(id)!);
let globe: Globe | null = null;
let awaiting = false; // waiting for a guess on the current round
let pending: { lon: number; lat: number } | null = null;
let shownScore = 0;

const total = () => state.guesses.reduce((t, g) => t + g.pts, 0);
const round = () => state.guesses.length; // index of the round being played
const shareUrl = () => location.origin + import.meta.env.BASE_URL;

// ---------- static UI ----------
el.date.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
el.confirm.checked = getPref('confirm');
el.confirm.addEventListener('change', () => {
  setPref('confirm', el.confirm.checked);
  if (!el.confirm.checked) clearPending();
});
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
  if (!awaiting) return;
  if (el.confirm.checked) {
    pending = { lon, lat };
    globe?.setPending(lon, lat);
    el.lock.hidden = false;
  } else {
    lockIn(lon, lat);
  }
}

function clearPending() {
  pending = null;
  globe?.clearPending();
  el.lock.hidden = true;
}

el.lock.addEventListener('click', () => {
  if (pending) lockIn(pending.lon, pending.lat);
});

function lockIn(lon: number, lat: number) {
  const i = round();
  const b = day[i];
  const km = distanceKm(lon, lat, b.lon, b.lat);
  const pts = points(km);
  awaiting = false;
  clearPending();
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
  el.qnum.textContent = 'DONE FOR TODAY';
  el.qtier.textContent = '';
  el.clue.textContent = `You scored ${total()} of 1000. Come back tomorrow for five new buildings.`;
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
    el.endCards.replaceChildren(
      ...state.guesses.map((g, i) => {
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
      }),
    );
  });

  el.shareText.textContent = shareText(state, shareUrl());
  el.end.hidden = false;
  el.end.scrollTop = 0;
  tickCountdown();
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
  const g = globe ?? (await globeReady);
  g.showAll(
    state.guesses.map((guess, i) => ({
      lon: day[i].lon,
      lat: day[i].lat,
      name: day[i].name,
      color: TIER_COLOR[day[i].tier],
      guess,
    })),
  );
});

el.resultsBtn.addEventListener('click', () => showEnd());

let countdownTimer = 0;
function tickCountdown() {
  clearTimeout(countdownTimer);
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
