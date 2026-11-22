// Step 1 of the building pipeline: pull candidate buildings from Wikidata
// (CC0) and measure how famous each one is.
//
//   node scripts/import-wikidata.mjs        → data/candidates.json
//
// A candidate is anything with coordinates and an English Wikipedia article that
//  - has an architect (P84) and is on ≥ 20 Wikipedias, or
//  - is a direct instance of a landmark class (palace, temple, cathedral, …) and
//    is on ≥ 35 Wikipedias (catches ancient buildings with no named architect).
// Fame = number of Wikipedias (sitelinks) and English-Wikipedia page views over
// the last 12 months.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

// Every stage checkpoints to data/.cache/, so a rerun resumes where it stopped.
const CACHE = new URL('../data/.cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });
const load = (name, fallback) => (existsSync(new URL(name, CACHE)) ? JSON.parse(readFileSync(new URL(name, CACHE), 'utf8')) : fallback);
const store = (name, v) => writeFileSync(new URL(name, CACHE), JSON.stringify(v));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const UA = { 'User-Agent': 'landmarked-data/1.0 (static game data import)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Landmark classes for buildings that may lack an architect statement.
const LANDMARK_CLASSES = {
  Q16560: 'palace', Q53536964: 'royal palace', Q23413: 'castle', Q44539: 'temple', Q842402: 'Hindu temple',
  Q5393308: 'Buddhist temple', Q32815: 'mosque', Q2977: 'cathedral', Q163687: 'basilica', Q16970: 'church building',
  Q24398318: 'religious building', Q1370598: 'place of worship', Q44613: 'monastery', Q12516: 'pyramid',
  Q180987: 'stupa', Q199451: 'pagoda', Q162875: 'mausoleum', Q381885: 'tomb', Q12518: 'tower',
  Q1440300: 'lattice tower', Q11166728: 'TV tower', Q11303: 'skyscraper', Q483110: 'stadium',
  Q153562: 'opera house', Q24354: 'theatre', Q54831: 'amphitheatre', Q2484376: 'Roman amphitheatre',
  Q19927: 'Greek temple', Q1065336: 'Roman temple', Q1785071: 'fort', Q57821: 'fortification',
  Q16831714: 'government building', Q33506: 'museum', Q7075: 'library', Q41176: 'building',
};

async function sparql(query, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const u = new URL('https://query.wikidata.org/sparql');
    u.searchParams.set('query', query);
    let res, text;
    try {
      res = await fetch(u, { headers: { ...UA, Accept: 'application/sparql-results+json' } });
      text = await res.text();
    } catch { res = { ok: false, status: 'network' }; }
    if (res.ok) {
      try { return JSON.parse(text).results.bindings; } catch { /* truncated by a server timeout */ }
    }
    console.warn(`  SPARQL ${res.status} (or timeout), retrying`);
    await sleep(5000 * (attempt + 1));
  }
  return null;
}
const qidOf = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

async function api(url, params) {
  const u = new URL(url);
  u.search = new URLSearchParams({ format: 'json', ...params });
  await sleep(250); // stay well under Wikimedia rate limits
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(u, { headers: UA });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return JSON.parse(text);
    } catch { /* network hiccup */ }
    await sleep(5000 * (attempt + 1));
  }
  throw new Error(`API failed: ${u}`);
}

// ---------- 1. candidate ids ----------
log('Querying Wikidata…');
const ids = new Map(Object.entries(load('ids.json', {}))); // qid → sitelinks
const haveIds = ids.size > 0;
const add = (rows) => {
  for (const r of rows) ids.set(qidOf(r.item.value), Number(r.links.value));
};
if (!haveIds) {
add((await sparql(`SELECT ?item ?links WHERE {
  ?item wdt:P84 [] ; wdt:P625 [] ; wikibase:sitelinks ?links .
  FILTER(?links >= 20)
}`)) ?? []);
console.log(`  with architect: ${ids.size}`);
for (const [cls, name] of Object.entries(LANDMARK_CLASSES)) {
  const rows = await sparql(`SELECT ?item ?links WHERE {
  ?item wdt:P31 wd:${cls} ; wdt:P625 [] ; wikibase:sitelinks ?links .
  FILTER(?links >= 35)
}`, 2);
  if (rows) add(rows);
  else console.warn(`  skipped class ${name} (timed out)`);
  await sleep(1000);
}
store('ids.json', Object.fromEntries(ids));
}
log(`candidates: ${ids.size}`);

// ---------- 2. details ----------
const claimIds = (e, p) => (e.claims?.[p] ?? []).filter((c) => c.rank !== 'deprecated').map((c) => c.mainsnak.datavalue?.value?.id).filter(Boolean);
const claimTime = (e, p) => {
  const t = e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value?.time;
  if (!t) return null;
  const y = parseInt(t.slice(0, t.indexOf('-', 1)), 10);
  return Number.isFinite(y) ? y : null;
};
const items = load('items.json', []);
const doneIds = new Set(load('items-done.json', []));
const all = [...ids.keys()].filter((q) => !doneIds.has(q));
log(`details: ${doneIds.size} cached, ${all.length} to fetch`);
for (let i = 0; i < all.length; i += 20) {
  const batch = all.slice(i, i + 20);
  const j = await api('https://www.wikidata.org/w/api.php', { action: 'wbgetentities', ids: batch.join('|'), props: 'labels|claims|sitelinks', sitefilter: 'enwiki', languages: 'en' });
  for (const [q, e] of Object.entries(j.entities)) {
    const c = e.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    const enwiki = e.sitelinks?.enwiki?.title;
    if (!c || !enwiki) continue;
    items.push({
      qid: q,
      label: e.labels?.en?.value ?? q,
      enwiki,
      sitelinks: ids.get(q),
      lat: +c.latitude.toFixed(5),
      lon: +c.longitude.toFixed(5),
      classes: claimIds(e, 'P31'),
      architects: claimIds(e, 'P84'),
      country: claimIds(e, 'P17')[0] ?? null,
      locatedIn: claimIds(e, 'P131')[0] ?? null,
      inception: claimTime(e, 'P571'),
      opened: claimTime(e, 'P1619'),
      demolished: Boolean(e.claims?.P576 || e.claims?.P5817?.some((s) => ['Q56556915', 'Q19860854'].includes(s.mainsnak.datavalue?.value?.id))),
    });
  }
  for (const q of batch) doneIds.add(q);
  if ((i / 20) % 10 === 0 || i + 20 >= all.length) {
    store('items.json', items);
    store('items-done.json', [...doneIds]);
    log(`details ${doneIds.size}/${ids.size}`);
  }
}

// ---------- 3. labels for referenced entities ----------
const refs = new Set(items.flatMap((x) => [...x.classes, ...x.architects, x.country, x.locatedIn]).filter(Boolean));
const labels = load('labels.json', {});
const refList = [...refs].filter((q) => !(q in labels));
log(`labels to fetch: ${refList.length}`);
for (let i = 0; i < refList.length; i += 50) {
  const j = await api('https://www.wikidata.org/w/api.php', { action: 'wbgetentities', ids: refList.slice(i, i + 50).join('|'), props: 'labels', languages: 'en' });
  for (const [q, e] of Object.entries(j.entities)) labels[q] = e.labels?.en?.value ?? q;
  if ((i / 50) % 10 === 0) store('labels.json', labels);
}
store('labels.json', labels);
console.log();
for (const x of items) {
  x.classLabels = x.classes.map((q) => labels[q]);
  x.architectLabels = x.architects.map((q) => labels[q]);
  x.countryLabel = labels[x.country] ?? null;
  x.locatedInLabel = labels[x.locatedIn] ?? null;
}

// ---------- 4. page views (English Wikipedia, last 60 days) ----------
// The action API's prop=pageviews returns 50 articles per request, which keeps
// us far below Wikimedia's rate limits. A rate-limited batch is retried, never
// recorded as zero.
const viewCache = load('views.json', {});
const titles = [...new Set(items.map((x) => x.enwiki))].filter((t) => !(t in viewCache));
log(`page views: ${titles.length} to fetch`);
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  // prop=pageviews only fills some pages per response; follow "continue" until
  // every page has its counts. Pages without counts yet are not recorded.
  let cont = {};
  for (let round = 0; round < 20; round++) {
    const j = await api('https://en.wikipedia.org/w/api.php', { action: 'query', prop: 'pageviews', pvipdays: '60', redirects: '1', titles: batch.join('|'), formatversion: '2', ...cont });
    const back = new Map();
    for (const r of [...(j.query?.normalized ?? []), ...(j.query?.redirects ?? [])]) back.set(r.to, r.from);
    for (const p of j.query?.pages ?? []) {
      if (!p.pageviews) continue;
      let t = p.title;
      while (back.has(t)) t = back.get(t);
      viewCache[t] = Object.values(p.pageviews).reduce((s, v) => s + (v ?? 0), 0);
    }
    if (!j.continue) break;
    cont = j.continue;
    await sleep(500);
  }
  if ((i / 50) % 10 === 0) { store('views.json', viewCache); log(`page views ${Math.min(i + 50, titles.length)}/${titles.length}`); }
  await sleep(1000);
}
for (const x of items) x.views = viewCache[x.enwiki] ?? 0;
store('views.json', viewCache);

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
items.sort((a, b) => b.sitelinks - a.sitelinks);
writeFileSync(new URL('../data/candidates.json', import.meta.url), JSON.stringify({ fetched: new Date().toISOString(), items }, null, 0));
console.log(`Wrote data/candidates.json: ${items.length} candidates`);
