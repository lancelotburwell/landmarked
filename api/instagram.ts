// Posts the Instagram sneak peeks straight to Instagram (Instagram API with Instagram
// Login), replacing Metricool. Nothing goes out without the owner's approval in the
// planner's Instagram tab (/planner.html#instagram).
//
// The posts come from the repo: data/social.json (date, optional "time" HH:MM in
// Europe/Zurich, default 08:00) and data/social-captions.json (images and caption, written
// by the "Render Instagram posts" Action). The images are served from landmarked.land.
//
// State lives in Upstash (no repo commits, so approving doesn't redeploy):
//   lm:ig:auth       { token, host, userId, username, savedAt, refreshedAt, expiresAt }
//
// Two kinds of token work. Apps made since 2026 use "Unified login": a Business Integration
// System User token (starts EAA, never expires) on graph.facebook.com, generated in the app's
// Instagram API setup → Generate access tokens. Older apps' Instagram Login tokens (start IG,
// 60 days, refreshed weekly here) use graph.instagram.com. The publishing calls are the same.
//   lm:ig:approved   hash date → { at }       (posts approved by hand)
//   lm:ig:auto       { on, since }             automatic mode: every post from `since` on goes out
//   lm:ig:held       hash date → { at }       posts kept back (in either mode)
//   lm:ig:posted     hash date → { state: publishing|posted|error, at, mediaId?, permalink?, container?, error?, tries? }
//   lm:ig:lock:<d>   short lock so two runs never post the same day twice
//
// GET  /api/instagram?key=<STATS_KEY>          the planner's list: account, posts and their state
// POST /api/instagram { key, action, ... }    approve { date, approved }, token { token },
//                                              disconnect, publish { date } (post now)
// POST /api/instagram { action: "run" } with Authorization: Bearer <CRON_SECRET>, or the key:
//   posts every approved post that is due today (Zurich time) and not posted yet, and
//   refreshes the token weekly. The "Publish Instagram posts" Action calls it every 15 minutes.
//
// Environment (Vercel): STATS_KEY, CRON_SECRET, the Upstash vars, GITHUB_TOKEN (optional,
// for reading the repo without the raw-file cache).
import { redis } from './_lib.js';

const HOSTS = { facebook: 'https://graph.facebook.com', instagram: 'https://graph.instagram.com' } as const;
type Host = keyof typeof HOSTS;
export interface Cred { token: string; host?: Host }
const TZ = 'Europe/Zurich';
const DEFAULT_TIME = '08:00';
const MAX_TRIES = 3;
const K = { auth: 'lm:ig:auth', approved: 'lm:ig:approved', posted: 'lm:ig:posted', lock: 'lm:ig:lock:', auto: 'lm:ig:auto', held: 'lm:ig:held' };

/** Automatic mode: every post dated on or after `since` goes out unless it is held. */
export interface Auto { on: boolean; since: string; at?: string }
const readAuto = async (s: IgStore): Promise<Auto | null> => parse(await s.get(K.auto));
/** Will this post go out at its time? Approved by hand, or automatic and not held. */
export const willPost = (date: string, approved: Json, held: Json, auto: Auto | null) => !held[date] && (!!approved[date] || (!!auto?.on && date >= auto.since));

type Json = Record<string, any>;
class Fail extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

export interface IgStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
}
// Upstash turns JSON strings back into objects on read; accept either.
const parse = (v: unknown): any => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return v; } };
const hall = async (s: IgStore, k: string): Promise<Record<string, any>> => Object.fromEntries(Object.entries((await s.hgetall(k)) ?? {}).map(([f, v]) => [f, parse(v)]));

export interface Post { date: string; time: string; id: string; name: string; images: string[]; text: string | null; clue: string | null; first: string }
export interface Auth extends Cred { userId: string; username: string; savedAt: string; refreshedAt: string; expiresAt: string | null }

// ---------- time ----------
/** Today's date and the time of day in Zurich. */
export function zurichNow(now = new Date()): { date: string; hm: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

// ---------- the posts, from the repo ----------
async function readRepo(path: string): Promise<any> {
  const repo = process.env.GITHUB_REPO ?? 'lancelotburwell/landmarked';
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  const res = process.env.GITHUB_TOKEN
    ? await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    : await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
  if (!res.ok) throw new Fail(`could not read ${path} from GitHub (${res.status})`, 502);
  return res.json();
}

export function mergePosts(social: Json[], captions: Json[]): Post[] {
  const cap = new Map(captions.map((c) => [c.date, c]));
  return social.map((s) => {
    const c = cap.get(s.date);
    return { date: s.date, time: /^\d{2}:\d{2}$/.test(s.time ?? '') ? s.time : DEFAULT_TIME, id: s.id, name: c?.name ?? s.id, images: c?.images ?? [], text: c?.text ?? null, clue: c?.clue ?? null, first: c?.first ?? s.first ?? 'clue' };
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
const loadPosts = async () => mergePosts(await readRepo('data/social.json'), await readRepo('data/social-captions.json'));

// ---------- Instagram Graph API ----------
async function graph(method: 'GET' | 'POST', path: string, params: Record<string, string>, cred: Cred): Promise<Json> {
  const GRAPH = HOSTS[cred.host ?? 'instagram'];
  const q = new URLSearchParams({ ...params, access_token: cred.token });
  const res = method === 'GET'
    ? await fetch(`${GRAPH}${path}?${q}`)
    : await fetch(`${GRAPH}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: q });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = j.error ?? {};
    throw new Fail(`Instagram: ${e.error_user_msg || e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : ''}`, 502);
  }
  return j;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFinished(id: string, token: Cred, wait = 2000): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { status_code } = await graph('GET', `/${id}`, { fields: 'status_code' }, token);
    if (status_code === 'FINISHED' || status_code === 'PUBLISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Fail(`Instagram could not process the media (${status_code})`, 502);
    await sleep(wait);
  }
  throw new Fail('Instagram is still processing the media; the next run tries again', 504);
}

/** One slide (or a single-image post). Alt text is newer API; drop it if Instagram refuses it. */
async function createImage(auth: Auth, url: string, extra: Record<string, string>, alt: string): Promise<string> {
  try {
    return (await graph('POST', `/${auth.userId}/media`, { image_url: url, ...extra, alt_text: alt }, auth)).id;
  } catch (e) {
    if (!/alt_text/i.test((e as Error).message)) throw e;
    return (await graph('POST', `/${auth.userId}/media`, { image_url: url, ...extra }, auth)).id;
  }
}

const altFor = (post: Post, url: string) => /-1\.jpg$/.test(url) && post.clue ? `Clue: ${post.clue}` : 'A close-up architectural detail of one of today\'s buildings';

export async function publish(store: IgStore, auth: Auth, post: Post, opts: { wait?: number } = {}): Promise<Json> {
  if (!post.text || !post.images.length) throw new Fail(`the ${post.date} post isn't rendered yet (no caption or images)`);
  if (post.images.length > 10) throw new Fail('a carousel takes at most 10 images');
  const prev = parse(await store.hgetall(K.posted).then((h) => h?.[post.date]));
  if (prev?.state === 'posted') return prev;

  let container: string | undefined = prev?.state === 'publishing' ? prev.container : undefined;
  if (container) {
    // A run died between creating and publishing: did it go out?
    const { status_code } = await graph('GET', `/${container}`, { fields: 'status_code' }, auth).catch(() => ({ status_code: 'GONE' }));
    if (status_code === 'PUBLISHED') {
      const done = { state: 'posted', at: new Date().toISOString(), container };
      await store.hset(K.posted, { [post.date]: JSON.stringify(done) });
      return done;
    }
    if (status_code !== 'FINISHED') container = undefined;
  }
  if (!container) {
    for (const u of post.images) {
      const r = await fetch(u, { method: 'HEAD' });
      if (!r.ok) throw new Fail(`${u} answered ${r.status}: not deployed yet?`, 502);
    }
    if (post.images.length === 1) {
      container = await createImage(auth, post.images[0], { caption: post.text }, altFor(post, post.images[0]));
    } else {
      const children: string[] = [];
      for (const u of post.images) children.push(await createImage(auth, u, { is_carousel_item: 'true' }, altFor(post, u)));
      for (const c of children) await waitFinished(c, auth, opts.wait);
      container = (await graph('POST', `/${auth.userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.text }, auth)).id as string;
    }
    await waitFinished(container, auth, opts.wait);
    await store.hset(K.posted, { [post.date]: JSON.stringify({ state: 'publishing', at: new Date().toISOString(), container, tries: prev?.tries ?? 0 }) });
  }
  const media = await graph('POST', `/${auth.userId}/media_publish`, { creation_id: container }, auth);
  let permalink: string | undefined;
  try { permalink = (await graph('GET', `/${media.id}`, { fields: 'permalink' }, auth)).permalink; } catch { /* posted anyway */ }
  const done = { state: 'posted', at: new Date().toISOString(), mediaId: media.id, permalink };
  await store.hset(K.posted, { [post.date]: JSON.stringify(done) });
  return done;
}

// ---------- token ----------
const preferred = 'landmarked.land';
export async function saveToken(store: IgStore, token: string): Promise<Auth> {
  token = token.trim();
  if (!/^[A-Za-z0-9_|.-]{40,}$/.test(token)) throw new Fail("that doesn't look like an Instagram access token");
  const now = new Date();
  let auth: Auth;
  if (/^IG/.test(token)) {
    const me = await graph('GET', '/me', { fields: 'user_id,username' }, { token, host: 'instagram' });
    auth = { token, host: 'instagram', userId: String(me.user_id ?? me.id), username: me.username, savedAt: now.toISOString(), refreshedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 86_400_000).toISOString() };
  } else {
    // Unified login: the token belongs to a system user; the Instagram accounts are assigned to it.
    const cred: Cred = { token, host: 'facebook' };
    let accounts: Json[] = [];
    try { accounts = (await graph('GET', '/me/assigned_instagram_accounts', { fields: 'id,username' }, cred)).data ?? []; } catch { /* a user token: try its Pages below */ }
    if (!accounts.length) {
      const pages = (await graph('GET', '/me/accounts', { fields: 'instagram_business_account{id,username}' }, cred)).data ?? [];
      accounts = pages.map((p: Json) => p.instagram_business_account).filter(Boolean);
    }
    const ig = accounts.find((a) => a.username === preferred) ?? accounts[0];
    if (!ig) throw new Fail('that token has no Instagram account attached');
    auth = { token, host: 'facebook', userId: String(ig.id), username: ig.username, savedAt: now.toISOString(), refreshedAt: now.toISOString(), expiresAt: null };
  }
  await store.set(K.auth, JSON.stringify(auth));
  return auth;
}

/** Long-lived tokens last 60 days; refresh once a week (it must be at least a day old). */
async function maybeRefresh(store: IgStore, auth: Auth, now = new Date()): Promise<Auth> {
  if ((auth.host ?? 'instagram') !== 'instagram' || !auth.expiresAt) return auth; // system-user tokens never expire
  if (now.getTime() - Date.parse(auth.refreshedAt) < 7 * 86_400_000) return auth;
  const j = await graph('GET', '/refresh_access_token', { grant_type: 'ig_refresh_token' }, auth);
  const next = { ...auth, token: j.access_token, refreshedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (Number(j.expires_in) || 60 * 86_400) * 1000).toISOString() };
  await store.set(K.auth, JSON.stringify(next));
  return next;
}

// ---------- the scheduled run ----------
export async function run(store: IgStore, posts: Post[], now = new Date(), opts: { wait?: number } = {}): Promise<{ posted: string[]; failed: Json[]; refreshed?: boolean; note?: string }> {
  let auth = parse(await store.get(K.auth)) as Auth | null;
  if (!auth) return { posted: [], failed: [], note: 'no Instagram account connected' };
  const out = { posted: [] as string[], failed: [] as Json[], refreshed: false };
  try { const a = await maybeRefresh(store, auth, now); out.refreshed = a !== auth; auth = a; } catch (e) { out.failed.push({ date: 'token', error: (e as Error).message }); }

  const { date, hm } = zurichNow(now);
  const approved = await hall(store, K.approved);
  const held = await hall(store, K.held);
  const auto = await readAuto(store);
  const posted = await hall(store, K.posted);
  const due = posts.filter((p) => p.date === date && p.time <= hm && willPost(p.date, approved, held, auto) && posted[p.date]?.state !== 'posted' && (posted[p.date]?.tries ?? 0) < MAX_TRIES);
  for (const p of due) {
    const lock = await store.set(K.lock + p.date, '1', { nx: true, ex: 300 });
    if (!lock) continue; // another run is on it
    try {
      await publish(store, auth!, p, opts);
      out.posted.push(p.date);
    } catch (e) {
      const tries = (posted[p.date]?.tries ?? 0) + 1;
      const fresh = parse((await store.hgetall(K.posted))?.[p.date]);
      await store.hset(K.posted, { [p.date]: JSON.stringify({ ...(fresh?.state === 'publishing' ? fresh : {}), state: fresh?.state === 'publishing' ? 'publishing' : 'error', at: new Date().toISOString(), error: (e as Error).message, tries }) });
      out.failed.push({ date: p.date, error: (e as Error).message, tries });
    } finally {
      await store.del(K.lock + p.date);
    }
  }
  return out;
}

// ---------- HTTP ----------
const noStore = { 'Cache-Control': 'no-store' };
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(request: Request): Promise<Response> {
  const key = process.env.STATS_KEY;
  if (!key || new URL(request.url).searchParams.get('key') !== key) return Response.json({ error: 'wrong key' }, { status: 403 });
  try {
    const store = redis() as unknown as IgStore;
    const [auth, approved, posted, posts, held, auto] = await Promise.all([store.get(K.auth).then(parse), hall(store, K.approved), hall(store, K.posted), loadPosts(), hall(store, K.held), readAuto(store)]);
    const today = zurichNow();
    let quota: Json | null = null;
    if (auth) quota = await graph('GET', `/${auth.userId}/content_publishing_limit`, { fields: 'quota_usage,config' }, auth).then((j) => j.data?.[0] ?? null).catch((e) => ({ error: (e as Error).message }));
    const from = new Date(Date.parse(today.date + 'T12:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);
    return Response.json({
      account: auth ? { host: auth.host ?? 'instagram', username: auth.username, savedAt: auth.savedAt, refreshedAt: auth.refreshedAt, expiresAt: auth.expiresAt } : null,
      quota, cron: !!process.env.CRON_SECRET, now: today, auto,
      posts: posts.filter((p) => p.date >= from).map((p) => ({ ...p, approved: approved[p.date] ?? null, held: held[p.date] ?? null, willPost: willPost(p.date, approved, held, auto), status: posted[p.date] ?? null })),
    }, { headers: noStore });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof Fail ? e.status : 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Json;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const cron = process.env.CRON_SECRET && request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
  const owner = process.env.STATS_KEY && body?.key === process.env.STATS_KEY;
  if (!owner && !(cron && body?.action === 'run')) return Response.json({ error: 'wrong key' }, { status: 403 });
  try {
    const store = redis() as unknown as IgStore;
    switch (body.action) {
      case 'run': {
        const r = await run(store, await loadPosts());
        // A failure answers 500 so the Action fails and GitHub emails the owner (at most MAX_TRIES times a post).
        return Response.json(r, { status: r.failed.length ? 500 : 200, headers: noStore });
      }
      case 'approve': {
        if (!isDate(body.date)) throw new Fail('need a date');
        if (body.approved === false) await store.hdel(K.approved, body.date);
        else await store.hset(K.approved, { [body.date]: JSON.stringify({ at: new Date().toISOString() }) });
        return Response.json({ ok: true }, { headers: noStore });
      }
      case 'publish': { // "Post now" from the planner, whatever the time
        if (!isDate(body.date)) throw new Fail('need a date');
        const auth = parse(await store.get(K.auth)) as Auth | null;
        if (!auth) throw new Fail('connect an Instagram account first');
        const post = (await loadPosts()).find((p) => p.date === body.date);
        if (!post) throw new Fail(`no post for ${body.date} in data/social.json`);
        const lock = await store.set(K.lock + post.date, '1', { nx: true, ex: 300 });
        if (!lock) throw new Fail('this post is being published right now', 409);
        try {
          await store.hset(K.approved, { [post.date]: JSON.stringify({ at: new Date().toISOString(), now: true }) });
          return Response.json({ ok: true, ...(await publish(store, auth, post)) }, { headers: noStore });
        } finally { await store.del(K.lock + post.date); }
      }
      case 'auto': { // automatic posting on/off; it starts with tomorrow's post (today's may have gone out elsewhere)
        const next = zurichNow(new Date(Date.now() + 86_400_000)).date;
        if (body.on) await store.set(K.auto, JSON.stringify({ on: true, since: isDate(body.since) ? body.since : next, at: new Date().toISOString() }));
        else await store.del(K.auto);
        return Response.json({ ok: true, auto: await readAuto(store) }, { headers: noStore });
      }
      case 'hold': {
        if (!isDate(body.date)) throw new Fail('need a date');
        if (body.held === false) await store.hdel(K.held, body.date);
        else await store.hset(K.held, { [body.date]: JSON.stringify({ at: new Date().toISOString() }) });
        return Response.json({ ok: true }, { headers: noStore });
      }
      case 'retry': { // clear a failed post's error so the next run tries again
        if (!isDate(body.date)) throw new Fail('need a date');
        const cur = parse((await store.hgetall(K.posted))?.[body.date]);
        if (cur?.state === 'posted') throw new Fail('already posted');
        if (cur?.state === 'publishing') await store.hset(K.posted, { [body.date]: JSON.stringify({ ...cur, tries: 0, error: undefined }) });
        else await store.hdel(K.posted, body.date);
        return Response.json({ ok: true }, { headers: noStore });
      }
      case 'token': {
        const auth = await saveToken(store, String(body.token ?? ''));
        return Response.json({ ok: true, username: auth.username, expiresAt: auth.expiresAt }, { headers: noStore });
      }
      case 'disconnect':
        await store.del(K.auth);
        return Response.json({ ok: true }, { headers: noStore });
      default:
        throw new Fail('unknown action');
    }
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    if (status === 500) console.error(e);
    return Response.json({ error: (e as Error).message }, { status });
  }
}
