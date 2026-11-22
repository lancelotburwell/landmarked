# Landmarked: notes for future sessions

A daily architecture geography game: a static Vite + TypeScript site with a CesiumJS globe.

## Hosting and deploy
- **Live at https://landmarked.land** on Vercel (team `burwellprojects-4986`, Hobby plan). Every push to `main` auto-deploys.
- **Commits must use this repo's git identity, "Burwell Projects"** (set in the repo's `git config`, same as the Spura repo). Vercel Hobby silently skips builds from any other commit author. Don't override it with `-c user.email=…`.
- The Vercel CLI is not logged in on this machine; deploy by `git push`.
- Domain is registered at Namecheap: apex A record `216.198.79.1`, `www` CNAME to Vercel. **Open:** `www.landmarked.land` still has to be added in Vercel → Settings → Domains (redirect to the apex); until then it fails over HTTPS.
- The old GitHub Pages workflow (`.github/workflows/deploy.yml`, BASE=/landmarked/) still deploys a copy to lancelotburwell.ch/landmarked. It can be removed once the user agrees.
- Vite `base` defaults to `/`; `vercel.json` sets cache headers.

## Layout
- `index.html` holds all the UI markup: top bar, HUD (score, question box, Results button), stage (globe, result card, pin sheet), and the intro, help and end overlays. The UI must render with no JS framework and before Cesium arrives.
- `src/main.ts`: game flow and DOM wiring. It sets `window.CESIUM_BASE_URL`, then loads `./globe` with a **dynamic import**, so Cesium stays out of the entry chunk. Never import `@cesium/*` from main.ts or game.ts, except `import type`.
- `src/game.ts`: pure logic. Daily picker, practice picker, scoring, distance, per-day localStorage (`landmarked:day:<YYYY-MM-DD>` or `landmarked:day:practice`; the old single key `landmarked:day` is still read), share text.
- `src/globe.ts`: everything Cesium. It uses `CesiumWidget`, not `Viewer`. Markers are Billboard/Label/PointPrimitive collections, and the dashed line is a `Primitive`. **Pins**: after a day is played, `showAll()` adds an HTML chip (photo and name) per building in a `.pins` layer, repositioned on every `postRender` and hidden on the far side of the globe. `onPinClick` opens the card, and `focus()` flies to the building.
- `src/data/buildings.json`: the building pool. Today it holds the original 50, each with `clue` and `blurb` (a fun description for the cards) and a `qid`.
- `public/photos/<id>.jpg` + `public/photos/credits.json`: one Wikimedia Commons photo per building (640 px; CC0, PD, CC BY or CC BY-SA only) with artist, licence and page. The credit is shown on each card, as the licences require. 47 of the 50 have a photo: villa-savoye and bosco-verticale have no image on Wikidata, and lotus-temple's is GFDL only.
- `public/borders.json`: Natural Earth borders and country codes (`scripts/build-borders.mjs`).
- `public/sw.js`: service worker. App files are cached first; NASA/EOX tiles go in a bounded cache.

## Features (as of 2026-11-22)
- Intro: whole globe visible, "Five buildings a day…", a single **Play** button (Resume / See results when relevant).
- Tapping the globe is the guess (the confirm/lock-in option was removed at the user's request). Neither a bottom bar nor an on-screen imagery credit is shown; the NASA credit is in How it works.
- End screen: score and verdict, results breakdown, share, countdown + "Practice round" link, then a card per building (photo, details, description, credit). Behind it, the buildings stay pinned to the globe.
- **Practice:** `?practice` resumes the last practice round and `?practice=new` deals a fresh random five. Today's puzzle is never affected. The user asked for this for testing and dropped a "past days" list.

## Rules and decisions
- **No Cesium ion**: `Ion.defaultAccessToken = ''`, and every imagery provider is passed explicitly.
- Imagery: bundled NaturalEarthII, then **public-domain NASA imagery by default** (the user chose it so ads are allowed): Blue Marble NG (levels 0–8) and Landsat WELD 2000 (to level 12, shown only from terrain level 8 because its no-data gaps make dark blocks over the sea). `?imagery=eox` swaps in EOX Sentinel-2 cloudless for comparison. EOX's server is non-commercial, and its credit is shown on screen in that mode.
- **Lighting is Google Earth style:** a camera-fixed `DirectionalLight` from over the viewer's left shoulder, so there's no night side; sun and moon are hidden. The user dropped real day/night on purpose.
- Import core math types from `@cesium/core`, not `@cesium/engine`. The engine re-exports are deprecated.
- Camera: no tilt and no look; minimum zoom 35 km with NASA (15 km with EOX); the home view fits the whole globe (`homeAlt()`).
- **Daily picker** (`pickDay`): draws days in order from `EPOCH` (2026-11-01; never change it). Buildings rest about 60% of their tier's cycle, and the day's five are at least 1,500 km apart. Changing the pool changes future days; a started day keeps its stored ids. New days need no publishing: they're computed in the browser at local midnight.
- Scoring: 200 points within 10 km, then `200·exp(-(km-10)/800)`.
- Styling: dark theme, accent `#e3b261`, IBM Plex Mono, phone first. Don't copy GeoSports' look.

## Building pipeline (growing the pool to 300) — IN PROGRESS
1. `node scripts/import-wikidata.mjs` → `data/candidates.json`. Holds 3,073 candidates with sitelinks, 60-day English Wikipedia views, architect, year and coordinates. Every stage checkpoints to `data/.cache/` (gitignored). Wikimedia rate-limits hard: the page views use the batched `prop=pageviews` with `continue`.
2. `node scripts/select-buildings.mjs 340` → `data/selection.json`. Filters non-buildings and stadiums; fame = 0.35·rank(sitelinks) + 0.65·rank(views); spread caps of 4 per 30 km and about 8.5% per country; tiers 37% easy / 26% medium / 37% hard. It also caches Wikipedia intros for clue writing.
3. Hand-written content goes in `data/clues/*.json` as `{ id: { name, architect, year, city, country, clue, blurb } }` or `{ id: { drop: "reason" } }`. `001-drops.json` already drops 26 picks: non-buildings plus politically charged ones (Putin's Palace, Mar-a-Lago, Yasukuni and others).
4. `node scripts/build-buildings.mjs 300` merges everything into `src/data/buildings.json`, recomputes tiers and flags missing fields or clues that contain the name.
5. `node scripts/fetch-photos.mjs` adds photos (it resumes and saves as it goes).

**Next step, waiting on the user's OK:**
- Cut about 20 of the weakest "hard" picks (e.g. Khor Virap, Herrenchiemsee, Beauvais).
- Cap castles and cathedrals, which Wikipedia fame over-represents.
- Keep all 50 originals, even though the ranking puts the modern ones (Kunsthaus Graz, Niterói…) last.
- Refill favouring modern architecture and Africa, South America and East Asia.

Then write clue and blurb for each new building in batches from its Wikipedia intro, build, fetch photos, playtest and deploy. The `build-buildings.mjs` top-300 cut currently drops originals ranked beyond 300, so make it always keep the originals.

## Verify changes
- `npm run build && npx vite preview --port 4173`, then `node scripts/playtest.mjs http://localhost:4173/ <outDir>` (also try `?practice=new`). It plays a full day at phone and desktop sizes in headless Chrome, opens a pin card and saves screenshots. `vite preview` caches its file list: restart it after a rebuild.
- `npm run measure -- <url>` gives Fast-4G timings. `node scripts/compare-imagery.mjs` shows EOX and NASA side by side.
- The desktop app's built-in browser pane throttles WebGL to about 2 fps; use the Puppeteer scripts instead.
- On Windows, the Bash tool sometimes mangles heredocs containing quotes. Write edit scripts with the Write tool, then run them with node.

## Open items
- `www.landmarked.land` in Vercel (see above).
- Before ads: cookie-consent banner, privacy policy and impressum; fact-check the clues and blurbs.
- Decide whether to retire the GitHub Pages copy.
