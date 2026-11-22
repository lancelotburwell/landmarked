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
  introNote: $('intro-note'),
  help: $('help'),
  menu: $<HTMLButtonElement>('menu-btn'),
  end: $('end'),
  endScore: $('end-score'),
  endBars: $('end-bars'),
  endList: $('end-list'),
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
  el.play.textContent = "See today's results";
  el.introNote.textContent = 'You played today. New buildings at midnight.';
} else if (state.guesses.length > 0) {
  el.play.textContent = `Resume · question ${state.guesses.length + 1} of ${ROUNDS}`;
}

// ---------- globe (loaded in the background) ----------
performance.mark('ui-ready');
const globeReady = import('./globe')
  .then(({ Globe }) => {
    // ?imagery=nasa switches to public-domain NASA imagery (for comparing).
    const imagery = new URLSearchParams(location.search).get('imagery') === 'nasa' ? 'nasa' : 'eox';
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
function showEnd() {
  awaiting = false;
  el.qnum.textContent = 'DONE FOR TODAY';
  el.qtier.textContent = '';
  el.clue.textContent = `You scored ${total()} of 1000. Come back tomorrow for five new buildings.`;
  renderDots();
  el.endScore.textContent = String(total());
  el.endBars.innerHTML = '';
  el.endList.innerHTML = '';
  state.guesses.forEach((g, i) => {
    const b = day[i];
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `<i style="height:0;background:${TIER_COLOR[b.tier]}"></i><span>${g.pts}</span>`;
    el.endBars.append(bar);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => ((bar.firstElementChild as HTMLElement).style.height = `${Math.max(4, (g.pts / 200) * 100)}%`)),
    );
    const li = document.createElement('li');
    li.innerHTML = `<span class="sw" style="background:${TIER_COLOR[b.tier]}"></span><span class="nm"></span><span class="pt">${g.pts}</span>`;
    const nm = li.querySelector('.nm')!;
    nm.textContent = b.name;
    const small = document.createElement('small');
    small.textContent = `${b.city}, ${b.country} · ${formatKm(g.km)}`;
    nm.append(small);
    el.endList.append(li);
  });
  el.shareText.textContent = shareText(state, shareUrl());
  el.end.hidden = false;
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
