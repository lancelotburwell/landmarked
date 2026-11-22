import pool from './data/buildings.json' with { type: 'json' };

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
export interface DayState { date: string; ids: string[]; guesses: Guess[] }

export const BUILDINGS = pool as Building[];
export const ROUNDS = 5;
export const MAX_POINTS = 200;
/** Order of tiers through the day. */
export const DAY_TIERS: Tier[] = ['easy', 'easy', 'medium', 'hard', 'hard'];
export const TIER_COLOR: Record<Tier, string> = { easy: '#8cc5a0', medium: '#e3b261', hard: '#e2775c' };

// ---------- dates ----------
/** Local calendar date as YYYY-MM-DD: a new puzzle at each player's midnight. */
export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Day 0 of the puzzle history. Never change it: every day depends on it. */
const EPOCH = Date.UTC(2026, 10, 1);
function dayNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86_400_000);
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
/**
 * The day's five buildings, the same for everyone on that date.
 *
 * Days are drawn in order from a fixed start (EPOCH), each with its own
 * date-seeded RNG, keeping track of when each building was last used:
 *  - a building only comes back once most of its tier has been seen
 *    (unused for floor(tier size / picks per day) - 1 days);
 *  - the day's five are at least MIN_SPREAD_KM apart, when the pool allows.
 * Adding buildings changes future days; a day already started keeps its
 * stored ids (see load()).
 */
export function pickDay(key: string): Building[] {
  const target = Math.max(0, dayNumber(key));
  while (history.length <= target) history.push(drawDay(history.length));
  return history[target];
}
/** Buildings on the same day are at least this far apart (when the pool allows). */
const MIN_SPREAD_KM = 1500;
const history: Building[][] = [];
const lastUsed = new Map<string, number>();

function drawDay(day: number): Building[] {
  const rnd = mulberry32(hash(`landmarked:day:${day}`));
  const out: Building[] = [];
  for (const tier of DAY_TIERS) {
    const list = BUILDINGS.filter((b) => b.tier === tier).sort((a, b) => a.id.localeCompare(b.id));
    const perDay = DAY_TIERS.filter((t) => t === tier).length;
    // Days a building rests before it can return: ~60% of a full cycle through its tier.
    const rest = Math.floor((list.length / perDay) * 0.6);
    const fresh = (days: number) => (b: Building) => day - (lastUsed.get(b.id) ?? -Infinity) > days;
    const apart = (b: Building) => out.every((o) => distanceKm(o.lon, o.lat, b.lon, b.lat) >= MIN_SPREAD_KM);
    const free = list.filter((b) => !out.includes(b));
    const both = (f: (b: Building) => boolean) => free.filter((b) => f(b) && apart(b));
    // Relax the rules step by step if the pool is too small to satisfy them all.
    const pool =
      [both(fresh(rest)), both(fresh(rest >> 1)), both(fresh(1)), free.filter(fresh(rest)), free].find((p) => p.length) ??
      list;
    const b = pool[Math.floor(rnd() * pool.length)];
    out.push(b);
    lastUsed.set(b.id, day);
  }
  return out;
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
export function points(km: number): number {
  if (km <= 10) return MAX_POINTS;
  return Math.round(MAX_POINTS * Math.exp(-(km - 10) / 800));
}
export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m away`;
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km).toLocaleString('en-US')} km away`;
}

// ---------- persistence ----------
const KEY = 'landmarked:day';
export function load(key: string): DayState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DayState | null;
    // Keep the stored ids so a mid-day data change can't swap buildings under a player.
    if (s && s.date === key && Array.isArray(s.ids) && s.ids.length === ROUNDS && s.ids.every((id) => byId(id))) return s;
  } catch { /* fresh start */ }
  return { date: key, ids: pickDay(key).map((b) => b.id), guesses: [] };
}
export function save(s: DayState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
export function getPref(name: string): boolean {
  try { return localStorage.getItem(`landmarked:${name}`) === '1'; } catch { return false; }
}
export function setPref(name: string, on: boolean) {
  try { localStorage.setItem(`landmarked:${name}`, on ? '1' : '0'); } catch { /* ignore */ }
}
export function byId(id: string): Building | undefined {
  return BUILDINGS.find((b) => b.id === id);
}

// ---------- sharing ----------
export function square(pts: number): string {
  if (pts >= 180) return '🟩';
  if (pts >= 120) return '🟨';
  if (pts >= 50) return '🟧';
  return '🟥';
}
export function shareText(s: DayState, url: string): string {
  const total = s.guesses.reduce((t, g) => t + g.pts, 0);
  const squares = s.guesses.map((g) => square(g.pts)).join('');
  const pts = s.guesses.map((g) => g.pts).join(' · ');
  return `Landmarked ${s.date}\n${squares} ${total}/1000\n${pts}\n${url}`;
}
