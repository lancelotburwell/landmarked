export type Tier = 'easy' | 'medium' | 'hard';
export interface Building {
  id: string;
  name: string;
  architect: string;
  year: string;
  city: string;
  country: string;
  tier: Tier;
  wiki: string;
  lon: number;
  lat: number;
  clue: string;
  /** Fun description shown on the end screen. */
  blurb?: string;
  qid?: string;
}
export interface Guess { lon: number; lat: number; km: number; pts: number }
/** late: finished through catch-up after its own day, so it doesn't count toward the streak. */
export interface DayState { date: string; ids: string[]; guesses: Guess[]; late?: boolean }

export const ROUNDS = 5;
export const MAX_POINTS = 200;
/** Order of tiers through the day. */
export const DAY_TIERS: Tier[] = ['easy', 'easy', 'medium', 'medium', 'hard'];
export const TIER_COLOR: Record<Tier, string> = { easy: '#8cc5a0', medium: '#e3b261', hard: '#e2775c' };

// ---------- dates ----------
/** Local calendar date as YYYY-MM-DD: a new puzzle at each player's midnight. */
export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function msToMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

// ---------- seeded RNG ----------
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- loading ----------
/** Buildings on the same day are at least this far apart (when the pool allows). */
const MIN_SPREAD_KM = 1500;
const BASE = import.meta.env.BASE_URL;
async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}
/** Every active building (for the fallback below). */
export function loadPool(): Promise<Building[]> {
  return getJSON<Building[]>('pool.json');
}
/**
 * The day's five buildings, the same for everyone on that date. They come
 * from public/days/<date>.json, written from data/schedule.json at build
 * time (see scripts/schedule.mjs). If the schedule has run out, everyone
 * gets the same date-seeded random five from the pool instead.
 */
export async function loadDay(date: string): Promise<Building[]> {
  try {
    const day = await getJSON<{ buildings: Building[] }>(`days/${date}.json`);
    if (day.buildings?.length === ROUNDS) return day.buildings;
  } catch { /* not scheduled */ }
  return pickPractice(await loadPool(), mulberry32(hash(`landmarked:fallback:${date}`)));
}

// ---------- scoring ----------
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371.0088;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Falloff distance in km. GeoGuessr's world map uses 1492.7 (half points at
 *  about 1,000 km); it was 800 until 2026-11-23, which felt too hard. */
const FALLOFF_KM = 1492.7;
export function points(km: number): number {
  if (km <= 10) return MAX_POINTS;
  return Math.round(MAX_POINTS * Math.exp(-(km - 10) / FALLOFF_KM));
}
export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m away`;
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km).toLocaleString('en-US')} km away`;
}

/** A random five (2 easy, 2 medium, 1 hard), spread out like a normal day. Not saved as today. */
export function pickPractice(pool: Building[], rnd = Math.random): Building[] {
  const out: Building[] = [];
  for (const tier of DAY_TIERS) {
    const free = pool.filter((b) => b.tier === tier && !out.includes(b));
    const apart = free.filter((b) => out.every((o) => distanceKm(o.lon, o.lat, b.lon, b.lat) >= MIN_SPREAD_KM));
    const from = apart.length ? apart : free;
    out.push(from[Math.floor(rnd() * from.length)]);
  }
  return out;
}

/** How many past days a player can catch up on. */
export const CATCH_UP = 5;
/** The CATCH_UP days before today, newest first. */
export function pastDays(today: string, n = CATCH_UP): string[] {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => todayKey(new Date(y, m - 1, d - 1 - i)));
}
/** A day's saved progress on this device: guesses made and points so far, or null. */
export function progress(day: string): { guesses: number; total: number } | null {
  try {
    const s = JSON.parse(localStorage.getItem(keyFor(day)) ?? 'null') as DayState | null;
    if (!s?.guesses?.length) return null;
    return { guesses: s.guesses.length, total: s.guesses.reduce((t, g) => t + g.pts, 0) };
  } catch { return null; }
}

export function formatDay(key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', opts);
}

// ---------- persistence ----------
// One entry per day, so past days keep their own progress.
const keyFor = (day: string) => `landmarked:day:${day}`;
const LEGACY_KEY = 'landmarked:day'; // single-day storage used before past days existed
function read(day: string, buildings: Building[]): DayState | null {
  const known = (id: string) => buildings.some((b) => b.id === id);
  try {
    for (const k of [keyFor(day), LEGACY_KEY]) {
      const s = JSON.parse(localStorage.getItem(k) ?? 'null') as DayState | null;
      // Keep the stored ids so a data change can't swap buildings under a player.
      if (s && s.date === day && Array.isArray(s.ids) && s.ids.length === ROUNDS && s.ids.every(known)) return s;
    }
  } catch { /* fresh start */ }
  return null;
}
/** Saved progress for a day, or a fresh start with the given buildings. */
export function load(day: string, buildings: Building[]): DayState {
  return read(day, buildings) ?? { date: day, ids: buildings.map((b) => b.id), guesses: [] };
}
/** Saved progress for a day whose buildings are all in `buildings`, without creating any. */
export function peek(day: string, buildings: Building[]): DayState | null {
  return read(day, buildings);
}
export function save(s: DayState) {
  try { localStorage.setItem(keyFor(s.date), JSON.stringify(s)); } catch { /* private mode */ }
}
export function getPref(name: string): boolean {
  try { return localStorage.getItem(`landmarked:${name}`) === '1'; } catch { return false; }
}
export function setPref(name: string, on: boolean) {
  try { localStorage.setItem(`landmarked:${name}`, on ? '1' : '0'); } catch { /* ignore */ }
}

// ---------- sharing ----------
export function square(pts: number): string {
  if (pts >= 180) return '🟩';
  if (pts >= 120) return '🟨';
  if (pts >= 50) return '🟧';
  return '🟥';
}
/** Puzzle number: #1 was 2026-11-01, the first day. */
export function puzzleNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2026, 10, 1)) / 86_400_000) + 1;
}
/**
 * Landmarked #22
 * 🟩🟨🟩🟧🟥 674/1000
 * landmarked.land
 * The bare domain still becomes a link in chat apps, and reads cleaner than https://.
 */
export function shareText(s: DayState, site: string): string {
  const total = s.guesses.reduce((t, g) => t + g.pts, 0);
  const squares = s.guesses.map((g) => square(g.pts)).join('');
  const title = `Landmarked #${puzzleNumber(s.date)}`;
  return `${title}\n${squares} ${total}/1000\n${site}`;
}

// ---------- stats ----------
export interface Stats {
  played: number;
  streak: number;
  bestStreak: number;
  average: number;
  best: number;
  /** Finished days per 200-point band: 0–199, 200–399, …, 800–1000. */
  bands: number[];
}
/** Stats from the finished days saved on this device. Catch-up days count, but not toward streaks. */
export function stats(today: string): Stats {
  const totals = new Map<string, number>();
  const onTime = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      if (k !== LEGACY_KEY && !/^landmarked:day:\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const s = JSON.parse(localStorage.getItem(k) ?? 'null') as DayState | null;
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || s.guesses?.length !== ROUNDS || s.date > today) continue;
      totals.set(s.date, s.guesses.reduce((t, g) => t + g.pts, 0));
      if (!s.late) onTime.add(s.date);
    }
  } catch { /* storage unavailable */ }
  const dates = [...onTime].sort();
  const n = (d: string) => puzzleNumber(d);
  // Best run of consecutive days.
  let bestStreak = 0, run = 0;
  dates.forEach((d, i) => { run = i && n(d) === n(dates[i - 1]) + 1 ? run + 1 : 1; bestStreak = Math.max(bestStreak, run); });
  // Current streak: ends today, or yesterday if today isn't finished yet.
  let streak = 0;
  for (let day = onTime.has(today) ? n(today) : n(today) - 1; dates.some((d) => n(d) === day); day--) streak++;
  const scores = [...totals.values()];
  const bands = [0, 0, 0, 0, 0];
  for (const t of scores) bands[Math.min(4, Math.floor(t / 200))]++;
  return {
    played: scores.length,
    streak,
    bestStreak,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    best: scores.length ? Math.max(...scores) : 0,
    bands,
  };
}
