# Landmarked

A daily architecture geography game. Each day there are five famous buildings (2 easy, 1 medium, 2 hard), the same for everyone. You get one clue per building and tap the 3D globe where you think it stands. Each building is worth up to 200 points, so the best possible day is 1,000.

**Play:** https://lancelotburwell.github.io/landmarked/

Built with Vite + TypeScript and [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0). It's a static site with no API keys and no Cesium ion.

## Run locally

```sh
npm install
npm run dev          # http://localhost:5173/landmarked/
```

Production build and preview:

```sh
npm run build        # tsc + vite build → dist/
npm run preview      # http://localhost:4173/landmarked/
```

Requires Node 22.17+ (needed by `@cesium/core`); CI uses Node 24.

### Scripts

| Script | What it does |
|---|---|
| `npm run verify-coords` | Checks every building's lon/lat against Wikipedia and Wikidata. Add `-- --write` to adopt Wikipedia's coordinates. |
| `node scripts/playtest.mjs [url] [outDir] [phone\|desktop]` | Plays a full day in headless Chrome at phone and desktop sizes and saves screenshots. Needs a running preview. |
| `node scripts/compare-imagery.mjs [url] [outDir]` | Screenshots the same views with EOX and NASA imagery for comparison. |
| `npm run measure -- [url] [runs]` | Measures time to an interactive globe on a throttled "Fast 4G" connection, cold and warm. |
| `node scripts/build-borders.mjs <dir>` | Rebuilds `public/borders.json` from Natural Earth 1:50m GeoJSON. |

The Puppeteer scripts use your local Chrome or Edge. Set `CHROME_PATH` if it isn't found.

## Deploy

Every push to `main` runs `.github/workflows/deploy.yml`, which builds the site and publishes it to GitHub Pages. The site is served from `/landmarked/`. For another host or path, build with `BASE=/your/path/ npm run build`. The Vite `base` and Cesium's `CESIUM_BASE_URL` both follow `BASE`.

One-time setup (already done for this repo): **Settings → Pages → Source: GitHub Actions**.

## Add buildings

Buildings live in `src/data/buildings.json`, one object per building:

```json
{ "id": "villa-savoye", "name": "Villa Savoye", "architect": "Le Corbusier & Pierre Jeanneret",
  "year": "1931", "city": "Poissy", "country": "France", "tier": "medium",
  "wiki": "Villa Savoye", "lon": 2.02833, "lat": 48.92444,
  "clue": "A white box on thin columns outside a capital, …" }
```

- `id`: unique, kebab-case. Never rename an existing id, because saved games refer to it.
- `tier`: `easy`, `medium` or `hard`. Keep the tiers roughly balanced: each day uses 2 easy, 1 medium and 2 hard.
- `wiki`: the exact English Wikipedia article title, used by the coordinate check.
- `clue`: describes the building without naming it. Avoid naming the city when that would give it away.
- Set rough coordinates, then run `npm run verify-coords -- --write` to adopt Wikipedia's coordinates. Anything flagged `CHECK` needs a manual look.

Adding buildings changes which buildings appear on future days (see `pickDay` in `src/game.ts`). Anyone who has already started today keeps their five.

## Credits and licences

- Globe: CesiumJS, Apache 2.0.
- Daytime imagery: **Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)**, CC BY 4.0. Tiles come from EOX's public tile server (see the commercial-use note below).
- Borders and country codes: Natural Earth (public domain).
- Font: IBM Plex Mono (SIL OFL), bundled with `@fontsource`.

### Before a commercial launch

The 2016 Sentinel-2 cloudless mosaic is licensed CC BY 4.0, which allows commercial use with attribution. **EOX's public tile server, however, is meant for non-commercial use.** Before launching commercially, either:

1. **Self-host the tiles.** Render or buy the 2016 mosaic (EOX sells the data, and the CC BY 2016 version can be self-processed from Copernicus data), cut it into Web Mercator tiles up to level 14, and serve them from object storage behind a CDN. Then change the URL in `src/globe.ts`. Levels 0–14 for the whole world add up to hundreds of GB, so a common approach is to serve levels 0–10 globally and higher levels only around the buildings in the pool.
2. **Get an EOX licence** for commercial use of their tile service (EOX offers commercial subscriptions for s2maps).

Natural Earth and CesiumJS are fine either way. For a free commercial-friendly fallback, NASA GIBS imagery (public domain, ~250–500 m/px) needs no key.
