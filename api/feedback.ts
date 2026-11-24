// POST /api/feedback  { message, day?, score?, rounds?, catchUp? }
// A player's message from the end screen ("Feedback straight to the creator").
// It is emailed to FEEDBACK_TO through Resend (RESEND_API_KEY; optional FEEDBACK_FROM,
// default Resend's onboarding sender, which only delivers to the Resend account's own address)
// and a copy is kept in Upstash (list lm:feedback, newest first, last 500) for the planner's
// Feedback tab, so nothing is lost if email isn't set up. No IP address or player id is stored.
// GET /api/feedback?key=<STATS_KEY> lists the stored messages.
import { redis } from './_lib.js';

interface ListStore {
  lpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}
const KEY = 'lm:feedback';
const MAX_PER_MINUTE = 10; // across everyone: enough for real players, stops a flood

export interface Feedback { at: string; message: string; day?: string; score?: number; rounds?: number; catchUp?: boolean; country?: string }

export function parseFeedback(body: unknown, country?: string | null, now = new Date()): Feedback | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.message !== 'string') return null;
  const message = b.message.replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!message) return null;
  const fb: Feedback = { at: now.toISOString(), message };
  if (typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day)) fb.day = b.day;
  if (typeof b.score === 'number' && Number.isInteger(b.score) && b.score >= 0 && b.score <= 1000) fb.score = b.score;
  if (typeof b.rounds === 'number' && Number.isInteger(b.rounds) && b.rounds >= 0 && b.rounds <= 5) fb.rounds = b.rounds;
  if (b.catchUp === true) fb.catchUp = true;
  if (country && /^[A-Z]{2}$/.test(country)) fb.country = country;
  return fb;
}

async function email(fb: Feedback): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO;
  if (!apiKey || !to) return false;
  const context = [
    fb.day && `Day ${fb.day}${fb.catchUp ? ' (catch-up)' : ''}`,
    fb.score !== undefined && `score ${fb.score}/1000 after ${fb.rounds ?? '?'} rounds`,
    fb.country && `from ${fb.country}`,
  ].filter(Boolean).join(', ');
  const first = fb.message.split('\n')[0].slice(0, 60);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FEEDBACK_FROM || 'Landmarked feedback <onboarding@resend.dev>',
      to: to.split(',').map((s) => s.trim()),
      subject: `Landmarked feedback: ${first}${fb.message.length > 60 ? '…' : ''}`,
      text: `${fb.message}\n\n---\n${context || 'No game context'}\nSent ${fb.at} from the end screen of landmarked.land`,
    }),
  });
  if (!res.ok) console.error('Resend answered', res.status, await res.text().catch(() => ''));
  return res.ok;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const fb = parseFeedback(body, request.headers.get('x-vercel-ip-country'));
  if (!fb) return Response.json({ error: 'empty message' }, { status: 400 });

  let store: ListStore | null = null;
  try { store = redis() as unknown as ListStore; } catch { /* Upstash not connected: email only */ }
  let stored = false;
  if (store) {
    try {
      const rate = `lm:feedback:rate:${fb.at.slice(0, 16)}`;
      const n = await store.incr(rate);
      if (n === 1) await store.expire(rate, 120);
      if (n > MAX_PER_MINUTE) return Response.json({ error: 'too many messages, try again in a minute' }, { status: 429 });
      await store.lpush(KEY, JSON.stringify(fb));
      await store.ltrim(KEY, 0, 499);
      stored = true;
    } catch (e) { console.error(e); }
  }
  let emailed = false;
  try { emailed = await email(fb); } catch (e) { console.error(e); }
  if (!stored && !emailed) return Response.json({ error: 'feedback is not set up' }, { status: 503 });
  return Response.json({ ok: true });
}

export async function GET(request: Request): Promise<Response> {
  const key = process.env.STATS_KEY;
  if (!key || new URL(request.url).searchParams.get('key') !== key) return Response.json({ error: 'not allowed' }, { status: 403 });
  try {
    const raw = await (redis() as unknown as ListStore).lrange(KEY, 0, 499);
    // Upstash parses JSON values itself; accept both forms.
    const items = raw.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    return Response.json({ items, email: Boolean(process.env.RESEND_API_KEY && process.env.FEEDBACK_TO) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'store unavailable' }, { status: 503 });
  }
}
