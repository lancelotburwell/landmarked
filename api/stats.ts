// GET /api/stats?key=<STATS_KEY>&days=30 → the daily counters for the private stats page.
// STATS_KEY is an environment variable set in Vercel; without it the endpoint stays closed.
import { lastDays, redis, summary } from './_lib.js';

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const key = process.env.STATS_KEY;
  if (!key || q.get('key') !== key) return Response.json({ error: 'not allowed' }, { status: 403 });
  const n = Math.min(90, Math.max(1, Number(q.get('days')) || 30));
  try {
    return Response.json({ days: await summary(redis(), lastDays(n)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'store unavailable' }, { status: 503 });
  }
}
