# Landmarked: notes for future sessions

A daily architecture geography game: a static Vite + TypeScript site with a CesiumJS globe, deployed to GitHub Pages at `/landmarked/`.

## Layout
- `index.html` holds all the UI markup (top bar, HUD, stage, bottom bar, intro/help/end overlays). The UI must render with no JS framework and before Cesium arrives.
- `src/main.ts`: game flow and DOM wiring. It sets `window.CESIUM_BASE_URL`, then loads `./globe` with a **dynamic import**, so Cesium stays out of the entry chunk (~12 KB gzip vs ~1 MB for the globe chunk). Keep it that way: never import `@cesium/*` from main.ts or game.ts, except `import type`.
- `src/game.ts`: pure logic. Daily picker, scoring, great-circle distance, localStorage, share text.
- `src/globe.ts`: everything Cesium. It uses `CesiumWidget`, not `Viewer`, so there are no Entities and DataSources. Markers are Billboard/Label/PointPrimitive collections, and the dashed line is a `Primitive` with `PolylineDash`.
- `src/data/buildings.json`: the 50 buildings. Coordinates were checked against Wikipedia and Wikidata with `npm run verify-coords`.
- `public/borders.json`: Natural Earth 1:50m land boundaries plus ISO-A2 label points. Generate it with `scripts/build-borders.mjs`.
- `public/sw.js`: service worker. The build stamps `__BUILD_ID__` (plugin in `vite.config.ts`). It serves the page network-first, same-origin files cache-first, and keeps a bounded cache of EOX tiles.

## Rules and decisions
- **No Cesium ion**: `Ion.defaultAccessToken = ''`, and every imagery provider is passed explicitly. Don't add anything that needs a token.
- Imagery layers, bottom to top: bundled NaturalEarthII (instant and offline), then EOX Sentinel-2 cloudless 2016 (levels 0–14). `?imagery=nasa` swaps EOX for public-domain NASA imagery (Blue Marble NG to level 8, then Landsat WELD 2000 to level 12, shown only from terrain level 8 because its no-data gaps make dark blocks over the sea). The user is weighing NASA as the free commercial option (2026-11-22).
- **Lighting is Google Earth style, not real sun time.** `scene.light` is a `DirectionalLight` that `preUpdate` re-aims every frame from over the viewer's left shoulder, so the visible face is always lit and only the lower-right limb is shaded. Sun and moon are hidden (they'd sit in the wrong place), and `globe.dynamicAtmosphereLightingFromSun = false` keeps the atmosphere on the same light. Shading fades out as you zoom in (`lightingFadeOut/InDistance`). The user dropped the NASA night-lights layer on purpose (2026-11-22); don't re-add a real-time day/night line without asking.
- Import core math types (`Cartesian3`, `Color`, `Math`, …) from `@cesium/core`, not `@cesium/engine`. Engine re-exports are deprecated and will be removed in Cesium 1.150.
- Camera: no tilt and no look, minimum zoom 15 km (Sentinel-2 is ~10 m/px, so closer is only blur), guesses come from `LEFT_CLICK` (fires only without a drag) + `pickEllipsoid`.
- Static copy: only `Workers`, `ThirdParty`, `Assets` and `Widgets` from `node_modules/cesium/Build/Cesium` go to `dist/cesium/` (`stripBase: 4`).
- **Daily picker** (`pickDay`): draws days in order from `EPOCH` (2026-11-01; never change it) with an RNG seeded by the day number. A building rests for ~60% of its tier's cycle before it can return, and the day's five are ≥1500 km apart when possible. Adding buildings changes future days. A day in progress keeps its stored ids (`load()`), and the ids are saved as soon as the page loads.
- Scoring: 200 points within 10 km, then `200·exp(-(km-10)/800)`, rounded. Distance uses the haversine formula with R = 6371.0088 km.
- Local calendar date (like Wordle): new buildings at each player's local midnight.
- Styling: dark theme, amber/sand accent `#e3b261`, IBM Plex Mono, phone first. Tier colours: easy `#8cc5a0`, medium `#e3b261`, hard `#e2775c`. Don't copy GeoSports' look.

## Verify changes
- `npm run build && npm run preview`, then `node scripts/playtest.mjs http://localhost:4173/landmarked/ <outDir>`. This plays a whole day at phone and desktop sizes in headless Chrome (SwiftShader WebGL) and writes screenshots; check them.
- `npm run measure -- <url>` gives Fast-4G timings. The page exposes `window.__landmarked = { tilesLoaded, globe }` and the performance marks `ui-ready`, `cesium-loaded`, `globe-ready` and `globe-tiles-loaded`.
- `vite preview` caches its file list: restart it after a rebuild if hashed files 404.
- The Claude desktop app's built-in browser pane throttles rAF to ~2 fps with WebGL, so its screenshots lag behind. Use the Puppeteer scripts instead.

## Open items
- The user plans ads, which makes it commercial: before ads go live, get an EOX licence or switch imagery (see README). Ads also need a cookie-consent banner (CH/EU visitors).
- EOX's public tile server is for non-commercial use. A commercial launch needs self-hosted tiles or an EOX licence (see README).
