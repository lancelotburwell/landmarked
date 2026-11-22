// Anonymous counters (see api/_lib.ts): only daily totals are stored, never
// a player id. Sends only on the real site (or with ?track for testing), and
// never lets a failure reach the game.
const ON = location.hostname === 'landmarked.land' || new URLSearchParams(location.search).has('track');
const API = `${import.meta.env.BASE_URL}api/`;

export type EventType = 'visit' | 'start' | 'finish' | 'share' | 'practice';
export interface Rank { players: number; beat: number }

async function post(body: Record<string, unknown>): Promise<Response | null> {
  if (!ON) return null;
  try {
    return await fetch(`${API}event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
  } catch {
    return null;
  }
}

/** Fire and forget. */
export function track(type: EventType, day: string, extra: Record<string, unknown> = {}): void {
  void post({ type, day, ...extra });
}

/** Counts an event once per day on this device (e.g. a reload must not count a second start). */
export function trackOnce(type: EventType, day: string, extra: Record<string, unknown> = {}): void {
  const key = `landmarked:sent:${day}:${type}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch { /* storage unavailable: send anyway */ }
  track(type, day, extra);
}

/** Records a finished day once and returns how it ranks; afterwards only reads the rank. */
export async function finishAndRank(day: string, score: number): Promise<Rank | null> {
  if (!ON) return null;
  const key = `landmarked:sent:${day}:finish`;
  let sent = false;
  try { sent = Boolean(localStorage.getItem(key)); } catch { /* ignore */ }
  try {
    let res: Response | null;
    if (sent) {
      res = await fetch(`${API}rank?day=${day}&score=${score}`);
    } else {
      res = await post({ type: 'finish', day, score });
      if (res?.ok) try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    }
    if (!res?.ok) return null;
    const r = (await res.json()) as Rank;
    return typeof r.players === 'number' && typeof r.beat === 'number' ? r : null;
  } catch {
    return null;
  }
}
