// POST /api/admin → the planner's editor (public/planner.html). Every change is a
// commit to the GitHub repo as "Burwell Projects", so the files in git stay the
// only source of truth; Vercel redeploys about a minute later. Changes that move
// buildings between days (pins, retiring) also start the nightly schedule Action.
//
// Environment (Vercel):
//   STATS_KEY      the owner's key, the same one as the stats page
//   GITHUB_TOKEN   fine-grained token for the repo: Contents read/write, Actions read/write
//   GITHUB_REPO    optional, default lancelotburwell/landmarked
//   GITHUB_BRANCH  optional, default main
//
// Body: { key, action, ... }
//   save    { id, fields?: { name, architect, year, city, country, blurb }, clues?: string[], checked?: boolean }
//           clues replaces the texts in place and may append; it can't remove one (the schedule points at them)
//   retire  { id, reason }
//   pin     { date, ids: string[], out?: string[], note? }   run ids that day and not the out ones;
//           replaces any earlier pin for that date, ids [] and no out removes it
//   hold    { id, notBefore: "YYYY-MM-DD" | null, note? }
//   photo   { id, file: "File:….jpg" }         a Wikimedia Commons file (CC0, PD, CC BY, CC BY-SA)

const AUTHOR = { name: 'Burwell Projects', email: 'burwell.projects@gmail.com' };
const OK_LICENSE = /^(CC0|Public domain|PD|CC BY(-SA)? \d)/i;
const UA = { 'User-Agent': 'landmarked-admin/1.0 (game data editor)' };

type Json = Record<string, any>;
class Fail extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

// GET /api/admin?diag → can this server reach Wikimedia? (No secrets involved.)
export async function GET(): Promise<Response> {
  try {
    const r = await fetch('https://commons.wikimedia.org/w/api.php?action=query&titles=File:Sydney_Opera_House_Sails.jpg&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json&formatversion=2', { headers: UA });
    const info = (await r.json())?.query?.pages?.[0]?.imageinfo?.[0];
    const t = info ? await fetch(info.thumburl, { headers: UA }) : null;
    return Response.json({ commonsApi: r.status, thumbUrl: info?.thumburl ?? null, thumb: t?.status ?? null, thumbBody: t && !t.ok ? (await t.text()).slice(0, 200) : null, ua: UA['User-Agent'] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return Response.json({ error: String((e as Error).message) }); }
}

export async function POST(request: Request): Promise<Response> {
  const key = process.env.STATS_KEY;
  let body: Json;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  if (!key || body?.key !== key) return Response.json({ error: 'Wrong key. Use the part after # in your stats link.' }, { status: 403 });
  if (body.action === 'ping') return Response.json({ ok: true, canSave: !!process.env.GITHUB_TOKEN }); // key check on unlock
  if (!process.env.GITHUB_TOKEN) return Response.json({ error: 'GITHUB_TOKEN is not set in Vercel' }, { status: 503 });
  try {
    const result = await handle(body);
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    if (status === 500) console.error(e);
    return Response.json({ error: (e as Error).message }, { status });
  }
}

// ---------- actions ----------
async function handle(b: Json): Promise<Json> {
  const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  switch (b.action) {
    case 'save': {
      const sha = await commit(`Edit ${b.id}`, async (read) => ({ 'data/buildings.json': editBuilding(await read('data/buildings.json'), b.id, (x) => {
        if (b.fields) for (const k of ['name', 'architect', 'year', 'city', 'country', 'blurb']) {
          if (b.fields[k] === undefined) continue;
          const v = String(b.fields[k]).trim();
          if (!v) throw new Fail(`${k} can't be empty`);
          x[k] = v;
        }
        if (b.clues) {
          if (!Array.isArray(b.clues) || b.clues.length < x.clues.length) throw new Fail('clues can be edited or added, not removed');
          const clues = b.clues.map((c: unknown) => String(c).trim());
          if (clues.some((c: string) => c.split(/\s+/).length < 6)) throw new Fail('a clue is too short');
          x.clues = clues;
        }
        if (b.checked === true) x.checked = new Date().toISOString().slice(0, 10);
        if (b.checked === false) delete x.checked;
      }) }));
      return { commit: sha };
    }
    case 'retire': {
      if (!b.reason) throw new Fail('give a reason');
      const sha = await commit(`Retire ${b.id}`, async (read) => ({ 'data/buildings.json': editBuilding(await read('data/buildings.json'), b.id, (x) => { x.retired = String(b.reason); }) }));
      await dispatchSchedule();
      return { commit: sha, rescheduling: true };
    }
    case 'pin': {
      const out: string[] = Array.isArray(b.out) ? b.out.map(String) : [];
      if (!isDate(b.date) || !Array.isArray(b.ids) || b.ids.length > 5) throw new Fail('need a date and up to five ids');
      const sha = await commit(b.ids.length ? `Pin ${b.ids.join(', ')} on ${b.date}` : `Unpin ${b.date}`, async (read) => {
        const ids = new Set(lines(await read('data/buildings.json')).map((x) => x.id));
        for (const id of [...b.ids, ...out]) if (!ids.has(id)) throw new Fail(`unknown building ${id}`);
        const pins = lines(await read('data/pins.json')).filter((p) => p.date !== b.date);
        if (b.ids.length || out.length) pins.push({ date: b.date, ids: b.ids, ...(out.length ? { out } : {}), ...(b.note ? { note: String(b.note) } : {}) });
        pins.sort((p, q) => String(p.date ?? p.notBefore).localeCompare(String(q.date ?? q.notBefore)));
        return { 'data/pins.json': serialise(pins) };
      });
      await dispatchSchedule();
      return { commit: sha, rescheduling: true };
    }
    case 'hold': {
      if (b.notBefore !== null && !isDate(b.notBefore)) throw new Fail('notBefore must be a date or null');
      const sha = await commit(b.notBefore ? `Hold ${b.id} until ${b.notBefore}` : `Release ${b.id}`, async (read) => {
        const pins = lines(await read('data/pins.json')).filter((p) => p.id !== b.id);
        if (b.notBefore) pins.push({ id: b.id, notBefore: b.notBefore, ...(b.note ? { note: String(b.note) } : {}) });
        return { 'data/pins.json': serialise(pins) };
      });
      await dispatchSchedule();
      return { commit: sha, rescheduling: true };
    }
    case 'photo': {
      const file = String(b.file ?? '').replace(/^File:/i, '');
      if (!file) throw new Fail('need a Commons file name');
      const q = new URLSearchParams({ action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '640', format: 'json', formatversion: '2' });
      const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: UA })).json();
      const info = j?.query?.pages?.[0]?.imageinfo?.[0];
      if (!info) throw new Fail('file not found on Commons');
      const m = info.extmetadata ?? {};
      const strip = (s?: string) => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      const license = strip(m.LicenseShortName?.value);
      if (!OK_LICENSE.test(license)) throw new Fail(`licence "${license || 'unknown'}" is not allowed (CC0, public domain, CC BY or CC BY-SA only)`);
      if (!/jpe?g/.test(info.mime ?? '')) throw new Fail('only JPEG photos (the site serves <id>.jpg)');
      const res = await fetch(info.thumburl ?? info.url, { headers: UA });
      if (!res.ok) throw new Fail(`Commons answered ${res.status}, try again in a minute`, 502);
      const bytes = Buffer.from(await res.arrayBuffer());
      const credit = { w: info.thumbwidth ?? info.width, h: info.thumbheight ?? info.height, artist: strip(m.Artist?.value).slice(0, 120) || 'Unknown', license, licenseUrl: m.LicenseUrl?.value ?? null, page: info.descriptionurl };
      const sha = await commit(`New photo for ${b.id}`, async (read) => {
        if (!lines(await read('data/buildings.json')).some((x) => x.id === b.id)) throw new Fail(`unknown building ${b.id}`);
        const credits = JSON.parse(await read('public/photos/credits.json'));
        credits[b.id] = credit;
        return { [`public/photos/${b.id}.jpg`]: bytes, 'public/photos/credits.json': JSON.stringify(credits, null, 1) + '\n' };
      });
      return { commit: sha, credit };
    }
    case 'suggest': { // a player's building suggestion, queued for the weekly routine (data/suggestions.json)
      const text = String(b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) throw new Fail('empty suggestion');
      const sha = await commit(`Queue building suggestion: ${text.slice(0, 60)}`, async (read) => {
        let rows: Json[] = [];
        try { rows = lines(await read('data/suggestions.json')); } catch { /* first one */ }
        if (rows.some((r) => r.text.toLowerCase() === text.toLowerCase())) throw new Fail('already queued');
        rows.push({ text, at: typeof b.at === 'string' ? b.at.slice(0, 30) : new Date().toISOString(), queued: new Date().toISOString().slice(0, 10), status: 'new' });
        return { 'data/suggestions.json': serialise(rows) };
      });
      return { commit: sha };
    }
    default:
      throw new Fail('unknown action');
  }
}

// ---------- one-entry-per-line JSON files ----------
const lines = (text: string): Json[] => JSON.parse(text);
const serialise = (rows: Json[]) => (rows.length ? '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n' : '[\n]\n');
function editBuilding(text: string, id: string, change: (b: Json) => void): string {
  const rows = lines(text);
  const b = rows.find((x) => x.id === id);
  if (!b) throw new Fail(`unknown building ${id}`);
  change(b);
  return serialise(rows);
}

// ---------- GitHub ----------
const repo = () => process.env.GITHUB_REPO ?? 'lancelotburwell/landmarked';
const branch = () => process.env.GITHUB_BRANCH ?? 'main';
async function gh(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${repo()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => null);
  if (!res.ok) { const e = new Fail(`GitHub ${res.status}: ${j?.message ?? 'error'}`, res.status === 422 ? 409 : 502); throw e; }
  return j;
}

// Reads files at the branch head, lets `make` produce the new contents, and adds one
// commit. If someone else pushed in between, it starts over from the new head.
async function commit(message: string, make: (read: (path: string) => Promise<string>) => Promise<Record<string, string | Buffer>>): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = (await gh(`/git/ref/heads/${branch()}`)).object.sha;
    const base = (await gh(`/git/commits/${head}`)).tree.sha;
    const read = async (path: string) => {
      const f = await gh(`/contents/${path}?ref=${head}`);
      if (f.content) return Buffer.from(f.content, 'base64').toString('utf8');
      return Buffer.from((await gh(`/git/blobs/${f.sha}`)).content, 'base64').toString('utf8'); // files over 1 MB
    };
    const files = await make(read);
    const tree = [];
    for (const [path, content] of Object.entries(files)) {
      const blob = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }) });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base, tree }) });
    const when = new Date().toISOString();
    const c = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message: `${message} (planner)`, tree: newTree.sha, parents: [head], author: { ...AUTHOR, date: when }, committer: { ...AUTHOR, date: when } }) });
    try {
      await gh(`/git/refs/heads/${branch()}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
      return c.sha;
    } catch (e) {
      if (e instanceof Fail && e.status === 409) continue; // the branch moved: redo on top of it
      throw e;
    }
  }
  throw new Fail('the repository kept changing, try again', 409);
}

// Re-plan now instead of tonight (the schedule Action commits and redeploys).
async function dispatchSchedule(): Promise<void> {
  await gh('/actions/workflows/schedule.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: branch() }) });
}
