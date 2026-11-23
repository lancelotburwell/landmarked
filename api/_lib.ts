// Anonymous daily counters for Landmarked, kept in Upstash Redis.
//
// Only per-day totals are stored: no player id, no IP address, no cookies.
//   lm:<day>          hash  visit, start, finish, share, returning, yesterday, practice
//   lm:<day>:hist     hash  finished scores in 10-point buckets (0..100) → count
//   lm:<day>:country  hash  country code (Vercel's x-vercel-ip-country) → visits
//   lm:<day>:ref      hash  referring site → visits
// Keys expire after 400 days. Files in api/ starting with "_" are not routes.
import { Redis } from '@upstash/redis';

export interface Store {
  hincrby(key: string, field: string, by: number): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function redis(): Store {
  // The Vercel Marketplace integration sets KV_REST_API_*; a direct Upstash setup sets UPSTASH_REDIS_REST_*.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Upstash is not connected (no REST URL/token in the environment)');
  return new Redis({ url, token }) as unknown as Store;
}

const TTL = 400 * 86_400;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['visit', 'start', 'finish', 'share', 'practice'] as const;
type EventType = (typeof TYPES)[number];
export interface GameEvent {
  type: EventType;
  day: string;
  score?: number;
  /** start: has played an earlier day on this device. */
  returning?: boolean;
  /** start: finished yesterday's puzzle too. */
  yesterday?: boolean;
  /** visit: hostname of the referring site. */
  ref?: string;
}

/** Days within two of today (UTC), to keep junk out: players are at most a day either side. */
export function plausibleDay(day: string, now = new Date()): boolean {
  if (!DAY.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Math.abs(t - now.getTime()) < 2.5 * 86_400_000;
}

export function parseEvent(body: unknown): GameEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!TYPES.includes(b.type as EventType) || typeof b.day !== 'string' || !plausibleDay(b.day)) return null;
  const ev: GameEvent = { type: b.type as EventType, day: b.day };
  if (ev.type === 'finish') {
    if (typeof b.score !== 'number' || !Number.isInteger(b.score) || b.score < 0 || b.score > 1000) return null;
    ev.score = b.score;
  }
  if (ev.type === 'start') {
    ev.returning = b.returning === true;
    ev.yesterday = b.yesterday === true;
  }
  if (ev.type === 'visit' && typeof b.ref === 'string') {
    const ref = b.ref.toLowerCase().replace(/^www\./, '').slice(0, 60);
    if (/^[a-z0-9.-]+$/.test(ref)) ev.ref = ref;
  }
  return ev;
}

const bucket = (score: number) => Math.min(100, Math.floor(score / 10));

export async function record(store: Store, ev: GameEvent, country?: string | null): Promise<void> {
  const k = `lm:${ev.day}`;
  const ops: Promise<unknown>[] = [store.hincrby(k, ev.type, 1), store.expire(k, TTL)];
  if (ev.type === 'start') {
    if (ev.returning) ops.push(store.hincrby(k, 'returning', 1));
    if (ev.yesterday) ops.push(store.hincrby(k, 'yesterday', 1));
  }
  if (ev.type === 'finish' && ev.score !== undefined) {
    ops.push(store.hincrby(`${k}:hist`, String(bucket(ev.score)), 1), store.expire(`${k}:hist`, TTL));
  }
  if (ev.type === 'visit') {
    if (country && /^[A-Z]{2}$/.test(country)) ops.push(store.hincrby(`${k}:country`, country, 1), store.expire(`${k}:country`, TTL));
    if (ev.ref) ops.push(store.hincrby(`${k}:ref`, ev.ref, 1), store.expire(`${k}:ref`, TTL));
  }
  await Promise.all(ops);
}

const counts = (h: Record<string, unknown> | null) =>
  Object.fromEntries(Object.entries(h ?? {}).map(([f, v]) => [f, Number(v) || 0])) as Record<string, number>;

/**
 * How a score compares with everyone who finished that day, plus the day's spread of
 * scores in ten 100-point bands (0–99 … 900–1000), for the end screen's chart.
 */
export async function rank(store: Store, day: string, score: number): Promise<{ players: number; beat: number; bands: number[] }> {
  const hist = counts(await store.hgetall(`lm:${day}:hist`));
  const mine = bucket(score);
  const bands = Array<number>(10).fill(0);
  let players = 0, below = 0;
  for (const [b, n] of Object.entries(hist)) {
    players += n;
    if (Number(b) < mine) below += n;
    bands[Math.min(9, Math.floor(Number(b) / 10))] += n;
  }
  return { players, beat: players ? Math.round((100 * below) / players) : 0, bands };
}

export interface DaySummary {
  day: string;
  totals: Record<string, number>;
  hist: Record<string, number>;
  country: Record<string, number>;
  ref: Record<string, number>;
}
export async function summary(store: Store, days: string[]): Promise<DaySummary[]> {
  return Promise.all(
    days.map(async (day) => {
      const k = `lm:${day}`;
      const [totals, hist, country, ref] = await Promise.all([k, `${k}:hist`, `${k}:country`, `${k}:ref`].map((x) => store.hgetall(x)));
      return { day, totals: counts(totals), hist: counts(hist), country: counts(country), ref: counts(ref) };
    }),
  );
}

/** The last n UTC days, newest first. */
export function lastDays(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
}
