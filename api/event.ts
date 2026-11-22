// POST /api/event  { type, day, score?, returning?, yesterday?, ref? }
// Adds one anonymous event to the day's counters. A finish answers with the
// day's rank so far: { players, beat } (beat = % of players with a lower score).
import { parseEvent, rank, record, redis } from './_lib.js';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const ev = parseEvent(body);
  if (!ev) return Response.json({ error: 'bad event' }, { status: 400 });
  try {
    const store = redis();
    await record(store, ev, request.headers.get('x-vercel-ip-country'));
    if (ev.type === 'finish') return Response.json(await rank(store, ev.day, ev.score!));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'store unavailable' }, { status: 503 });
  }
}
