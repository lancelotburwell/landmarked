// GET /api/rank?day=YYYY-MM-DD&score=674 → { players, beat, bands }
// How a finished score compares with everyone else that day (read only).
import { plausibleDay, rank, redis } from './_lib.js';

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const day = q.get('day') ?? '';
  const score = Number(q.get('score'));
  if (!plausibleDay(day) || !Number.isInteger(score) || score < 0 || score > 1000) return Response.json({ error: 'bad request' }, { status: 400 });
  try {
    return Response.json(await rank(redis(), day, score), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'store unavailable' }, { status: 503 });
  }
}
