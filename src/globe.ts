// Everything Cesium lives here. main.ts loads this module with a dynamic import,
// so the UI renders before the ~1 MB (gzip) engine arrives.
import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  EllipsoidGeodesic,
  GeometryInstance,
  Math as CesiumMath,
  PolylineGeometry,
} from "@cesium/core";
import {
  BillboardCollection,
  CesiumWidget,
  DirectionalLight,
  Credit,
  HorizontalOrigin,
  ImageryLayer,
  Ion,
  LabelCollection,
  LabelStyle,
  Material,
  PointPrimitiveCollection,
  PolylineCollection,
  PolylineMaterialAppearance,
  Primitive,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  WebMercatorTilingScheme,
  buildModuleUrl,
} from "@cesium/engine";
import '@cesium/engine/Source/Widget/CesiumWidget.css';

// No Cesium ion: every imagery source below is passed explicitly.
Ion.defaultAccessToken = '';

const EOX_CREDIT =
  'Sentinel-2 cloudless – <a href="https://s2maps.eu" target="_blank" rel="noopener">https://s2maps.eu</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 &amp; 2017)';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const NASA_CREDIT = 'Imagery: NASA Blue Marble &amp; Landsat WELD (USGS/NASA), via NASA GIBS';

/** 'eox': Sentinel-2 cloudless (sharp, non-commercial server). 'nasa': public-domain NASA imagery. */
export type Imagery = 'eox' | 'nasa';

const MARK_H = 40; // m above the ellipsoid, keeps markers out of z-fighting
const LINE_H = 300;
const BORDER_H = 300;

export interface Marker {
  lon: number;
  lat: number;
  name: string;
  color: string;
  guess?: { lon: number; lat: number };
}
/** A building pinned to the globe after the day is played: a chip with photo and name above its flag. */
export interface PinMarker extends Marker {
  id: string;
  photo?: string;
}

export class Globe {
  readonly widget: CesiumWidget;
  private points: PointPrimitiveCollection;
  private flags: BillboardCollection;
  private labels: LabelCollection;
  private lines: Primitive[] = [];
  private pending?: ReturnType<PointPrimitiveCollection['add']>;
  private clickCb?: (lon: number, lat: number) => void;
  private flagImages = new Map<string, HTMLCanvasElement>();
  private pinLayer: HTMLDivElement;
  private pins: { el: HTMLElement; pos: Cartesian3 }[] = [];
  private pinCb?: (id: string) => void;
  private scratch3 = new Cartesian3();
  private scratch2 = new Cartesian2();
  /** Resolves when the first full set of tiles has been drawn. */
  readonly tilesLoaded: Promise<void>;
  private imagery: Imagery = 'nasa';

  constructor(el: HTMLElement, creditEl: HTMLElement, imagery: Imagery = 'nasa') {
    const dpr = window.devicePixelRatio || 1;
    const widget = new CesiumWidget(el, {
      // 1. Bundled NaturalEarthII: shows a globe instantly, even offline.
      baseLayer: ImageryLayer.fromProviderAsync(
        TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
        {},
      ),
      creditContainer: creditEl,
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: false,
      showRenderLoopErrors: true,
      // No multisample anti-aliasing: it multiplies the GPU's work per pixel, and
      // at 1.5× resolution the edges look fine without it.
      msaaSamples: 1,
    });
    this.widget = widget;
    // Render at most 1.5× CSS pixels (phones are 3×): about half the pixels of 2×,
    // still crisp, and much lighter on phone GPUs.
    widget.resolutionScale = Math.min(dpr, 1.5) / dpr;

    const scene = widget.scene;
    const layers = scene.imageryLayers;

    if (imagery === 'eox') {
      // 2. Daytime satellite: Sentinel-2 cloudless 2016, ~10 m/px.
      layers.addImageryProvider(
        new UrlTemplateImageryProvider({
          url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
          tilingScheme: new WebMercatorTilingScheme(),
          maximumLevel: 14,
          credit: new Credit(EOX_CREDIT, true),
        }),
      );
    } else {
      // 2. NASA Blue Marble Next Generation, ~500 m/px, public domain.
      const marble = layers.addImageryProvider(
        new UrlTemplateImageryProvider({
          url: `${GIBS}/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
          tilingScheme: new WebMercatorTilingScheme(),
          maximumLevel: 8,
          credit: new Credit(NASA_CREDIT, true),
        }),
      );
      // Brighter, slightly richer colours stand in for the ground atmosphere (off,
      // see below), so the oceans read blue rather than black.
      marble.gamma = 1.6;
      marble.brightness = 1.15;
      marble.saturation = 1.15;
      // No close-up Landsat layer: switching it on while zooming in froze the globe
      // for 1-2 s on phones, and Blue Marble is detailed enough to place a guess.
    }

    const globe = scene.globe;
    globe.baseColor = Color.fromCssColorString('#0a1622');
    globe.enableLighting = true;
    // Ground atmosphere off: when zooming in it switches to another shader, and
    // compiling that froze the globe for 1-2 s (even pre-warming left ~0.25 s).
    // The sky atmosphere (the halo) stays; the imagery is brightened instead.
    globe.showGroundAtmosphere = false;
    globe.dynamicAtmosphereLighting = true;
    globe.dynamicAtmosphereLightingFromSun = false; // atmosphere follows scene.light
    // Shading is strongest on the whole-globe view and fades out as you zoom
    // in, so close-ups are always evenly lit.
    globe.lightingFadeOutDistance = 2.5e6;
    globe.lightingFadeInDistance = 8.0e6;
    globe.tileCacheSize = 300;
    globe.preloadAncestors = true;

    // Google Earth-style light: it comes from over the viewer's left shoulder
    // and follows the camera, so whatever you look at is in daylight and only
    // the lower-right limb falls into shadow. (No real sun, no night side.)
    const light = new DirectionalLight({ direction: Cartesian3.negate(Cartesian3.UNIT_Z, new Cartesian3()), intensity: 2.0 });
    scene.light = light;
    const dir = new Cartesian3();
    const tmp = new Cartesian3();
    scene.preUpdate.addEventListener(() => {
      const cam = scene.camera;
      Cartesian3.clone(cam.directionWC, dir);
      Cartesian3.add(dir, Cartesian3.multiplyByScalar(cam.rightWC, 0.85, tmp), dir);
      Cartesian3.add(dir, Cartesian3.multiplyByScalar(cam.upWC, -0.75, tmp), dir);
      Cartesian3.normalize(dir, light.direction);
    });

    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    // The real sun and moon would sit in the wrong place for this light.
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;

    const ctrl = scene.screenSpaceCameraController;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;
    // Closest zoom: stop where the imagery would start to look blurry (see closestAlt).
    this.imagery = imagery;
    ctrl.minimumZoomDistance = this.closestAlt();
    scene.preUpdate.addEventListener(() => { ctrl.minimumZoomDistance = this.closestAlt(); });
    ctrl.maximumZoomDistance = 4.0e7;

    // Start over the player's own longitude (from their time zone), mid-latitudes.
    const lon = Math.max(-170, Math.min(170, (-new Date().getTimezoneOffset() / 60) * 15));
    scene.camera.setView({ destination: Cartesian3.fromDegrees(lon, 22, this.homeAlt()) });

    this.points = scene.primitives.add(new PointPrimitiveCollection());
    this.flags = scene.primitives.add(new BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new LabelCollection({ scene }));

    // HTML chips that follow their flags as the globe turns.
    this.pinLayer = document.createElement('div');
    this.pinLayer.className = 'pins';
    el.append(this.pinLayer);
    scene.postRender.addEventListener(() => this.placePins());

    // Cesium only fires LEFT_CLICK when the pointer didn't drag.
    const handler = new ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const c = scene.camera.pickEllipsoid(e.position, globe.ellipsoid);
      if (!c || !this.clickCb) return;
      const carto = Cartographic.fromCartesian(c);
      this.clickCb(CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude));
    }, ScreenSpaceEventType.LEFT_CLICK);

    this.tilesLoaded = new Promise((resolve) => {
      const off = scene.postRender.addEventListener(() => {
        if (globe.tilesLoaded) {
          off();
          resolve();
        }
      });
    });

    void this.loadBorders();
  }

  onClick(cb: (lon: number, lat: number) => void) {
    this.clickCb = cb;
  }

  private get scene() {
    return this.widget.scene;
  }

  private render() {
    this.scene.requestRender();
  }

  // ---------- borders + country codes ----------
  private async loadBorders() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}borders.json`);
      const data = (await res.json()) as { lines: number[][]; labels: [string, number, number, number][] };
      const lines = this.scene.primitives.add(new PolylineCollection());
      const material = Material.fromType('Color', { color: Color.WHITE.withAlpha(0.42) });
      for (const flat of data.lines) {
        // Densify long straight runs so chords don't dip under the ellipsoid.
        const pts: number[] = [];
        for (let i = 0; i < flat.length - 2; i += 2) {
          const [x1, y1, x2, y2] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]];
          const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.3));
          for (let s = 0; s < steps; s++) pts.push(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps, BORDER_H);
        }
        pts.push(flat[flat.length - 2], flat[flat.length - 1], BORDER_H);
        lines.add({ positions: Cartesian3.fromDegreesArrayHeights(pts), width: 1, material });
      }

      await document.fonts.load('500 11px "IBM Plex Mono"').catch(() => undefined);
      const codes = this.scene.primitives.add(new LabelCollection({ scene: this.scene }));
      for (const [code, lon, lat, rank] of data.labels) {
        const far = rank <= 2 ? 2.6e7 : rank <= 3 ? 1.4e7 : rank <= 4 ? 8e6 : rank <= 5 ? 5e6 : 2.5e6;
        codes.add({
          position: Cartesian3.fromDegrees(lon, lat, 2_000),
          text: code,
          font: '600 11px "IBM Plex Mono", monospace',
          fillColor: Color.WHITE.withAlpha(0.8),
          outlineColor: Color.BLACK.withAlpha(0.8),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          distanceDisplayCondition: new DistanceDisplayCondition(0, far),
        });
      }
      this.render();
    } catch (err) {
      console.warn('borders failed', err);
    }
  }

  // ---------- markers ----------
  private flagImage(color: string): HTMLCanvasElement {
    const hit = this.flagImages.get(color);
    if (hit) return hit;
    const s = 2; // drawn at 2×, displayed at 1×
    const c = document.createElement('canvas');
    c.width = 36 * s;
    c.height = 46 * s;
    const g = c.getContext('2d')!;
    g.scale(s, s);
    // pole
    g.strokeStyle = '#f4efe6';
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(4, 45);
    g.lineTo(4, 3);
    g.stroke();
    // cloth with a slight wave
    g.fillStyle = color;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(5, 3);
    g.bezierCurveTo(14, 0, 22, 7, 33, 3);
    g.lineTo(33, 21);
    g.bezierCurveTo(22, 25, 14, 18, 5, 21);
    g.closePath();
    g.fill();
    g.stroke();
    // foot
    g.fillStyle = '#f4efe6';
    g.beginPath();
    g.arc(4, 43.5, 2.5, 0, Math.PI * 2);
    g.fill();
    this.flagImages.set(color, c);
    return c;
  }

  private addFlag(lon: number, lat: number, name: string, color: string, label = true) {
    const position = Cartesian3.fromDegrees(lon, lat, MARK_H);
    this.flags.add({
      position,
      image: this.flagImage(color),
      width: 36,
      height: 46,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.LEFT,
      pixelOffset: new Cartesian2(-4, 2),
    });
    if (label) this.labels.add({
      position,
      text: name,
      font: '600 13px "IBM Plex Mono", monospace',
      fillColor: Color.fromCssColorString('#f4efe6'),
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#0e1012').withAlpha(0.88),
      backgroundPadding: new Cartesian2(8, 5),
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: new Cartesian2(0, -50),
    });
  }

  private addGuessDot(lon: number, lat: number, color = '#f4efe6') {
    return this.points.add({
      position: Cartesian3.fromDegrees(lon, lat, MARK_H),
      pixelSize: 11,
      color: Color.fromCssColorString(color),
      outlineColor: Color.fromCssColorString('#0e1012'),
      outlineWidth: 2.5,
    });
  }

  private addDashedLine(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
    const line = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new PolylineGeometry({
          positions: Cartesian3.fromDegreesArrayHeights([a.lon, a.lat, LINE_H, b.lon, b.lat, LINE_H]),
          width: 3,
          arcType: ArcType.GEODESIC,
          granularity: CesiumMath.RADIANS_PER_DEGREE * 0.2,
        }),
      }),
      appearance: new PolylineMaterialAppearance({
        material: Material.fromType('PolylineDash', {
          color: Color.fromCssColorString('#f4efe6'),
          gapColor: Color.TRANSPARENT,
          dashLength: 14,
        }),
      }),
      asynchronous: false,
    });
    this.scene.primitives.add(line);
    this.lines.push(line);
  }

  setPending(lon: number, lat: number) {
    if (this.pending) this.points.remove(this.pending);
    this.pending = this.addGuessDot(lon, lat, '#e3b261');
    this.render();
  }

  clearPending() {
    if (this.pending) this.points.remove(this.pending);
    this.pending = undefined;
    this.render();
  }

  clear() {
    this.clearPending();
    this.points.removeAll();
    this.flags.removeAll();
    this.labels.removeAll();
    this.pinLayer.replaceChildren();
    this.pins = [];
    for (const l of this.lines) this.scene.primitives.remove(l);
    this.lines = [];
    this.render();
  }

  /** Guess dot, flag on the real spot, dashed line between, camera framing both. */
  showResult(m: Marker & { guess: { lon: number; lat: number } }, bottomInset = 0) {
    this.clear();
    this.addDashedLine(m.guess, m);
    this.addGuessDot(m.guess.lon, m.guess.lat);
    this.addFlag(m.lon, m.lat, m.name, m.color, false); // no name label: the card shows it (user, 2026-11-25)
    this.lastPair = [m.guess, m];
    this.frame(m.guess, m, bottomInset);
  }

  /** Re-frames the last result for a card that now covers bottomInset of the canvas. */
  reframe(bottomInset: number, duration = 0.9) {
    if (this.lastPair) this.frame(this.lastPair[0], this.lastPair[1], bottomInset, 60_000, duration);
  }
  private lastPair?: [{ lon: number; lat: number }, { lon: number; lat: number }];

  /** All of today's buildings, with the player's guesses. */
  showAll(markers: PinMarker[]) {
    this.clear();
    for (const m of markers) {
      if (m.guess) {
        this.addDashedLine(m.guess, m);
        this.addGuessDot(m.guess.lon, m.guess.lat);
      }
      this.addFlag(m.lon, m.lat, m.name, m.color, false);
      const chip = document.createElement('button');
      chip.className = 'pin';
      chip.style.setProperty('--c', m.color);
      chip.setAttribute('aria-label', `About ${m.name}`);
      if (m.photo) {
        const img = document.createElement('img');
        img.src = m.photo;
        img.alt = '';
        img.loading = 'lazy';
        chip.append(img);
      }
      const name = document.createElement('span');
      name.textContent = m.name;
      chip.append(name);
      chip.addEventListener('click', () => this.pinCb?.(m.id));
      this.pinLayer.append(chip);
      this.pins.push({ el: chip, pos: Cartesian3.fromDegrees(m.lon, m.lat, MARK_H) });
    }
    this.render();
    this.flyHome();
  }

  onPinClick(cb: (id: string) => void) {
    this.pinCb = cb;
  }

  /** Keeps each chip just above its flag; hides chips on the far side of the globe. */
  private placePins() {
    if (!this.pins.length) return;
    const scene = this.scene;
    const cam = scene.camera.positionWC;
    for (const p of this.pins) {
      const toCam = Cartesian3.subtract(cam, p.pos, this.scratch3);
      const facing = Cartesian3.dot(p.pos, toCam) > 0;
      const c = facing ? scene.cartesianToCanvasCoordinates(p.pos, this.scratch2) : undefined;
      if (!c) {
        p.el.style.visibility = 'hidden';
        continue;
      }
      p.el.style.visibility = '';
      p.el.style.transform = `translate(calc(${c.x}px - 50%), calc(${c.y}px - 100% - 50px))`;
    }
  }

  /** Flies straight down over a building, keeping it above a card covering bottomInset (0..1) of the canvas. */
  focus(lon: number, lat: number, bottomInset = 0) {
    this.frame({ lon, lat }, { lon, lat }, bottomInset, this.closestAlt());
  }

  /**
   * The closest camera height before the imagery looks blurry. Blue Marble has about
   * 600 m per pixel at the equator, so we stop where one rendered pixel covers about
   * that much ground: roughly 530 km on a phone and higher on a big screen (measured
   * 2026-11-23: 250 km was blurry, 400 km soft, 600 km sharp). Sentinel-2 (EOX) is
   * ~10 m/px, so it can go down to 15 km.
   */
  closestAlt(): number {
    if (this.imagery === 'eox') return 15_000;
    const scene = this.widget.scene;
    const canvas = scene.canvas;
    const fov = (scene.camera.frustum as unknown as { fov?: number }).fov ?? CesiumMath.PI_OVER_THREE;
    // Cesium's fov spans the longer side; drawing-buffer pixels include resolutionScale.
    const px = Math.max(canvas.width, canvas.height, 1);
    return Math.max(250_000, (600 * px) / (2 * Math.tan(fov / 2)));
  }

  /** Camera height at which the whole globe fits the canvas's shorter side, with a margin. */
  homeAlt(): number {
    const scene = this.widget.scene;
    const canvas = scene.canvas;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const fov = (scene.camera.frustum as unknown as { fov?: number }).fov ?? CesiumMath.PI_OVER_THREE;
    // Cesium's fov spans the longer side; get the half-angle of the shorter one.
    const tanBig = Math.tan(fov / 2);
    const half = Math.atan(aspect >= 1 ? tanBig / aspect : tanBig * aspect);
    const R = scene.globe.ellipsoid.maximumRadius;
    return R / Math.sin(half * 0.86) - R;
  }

  flyHome(duration = 1.6) {
    const c = this.scene.camera.positionCartographic;
    this.scene.camera.flyTo({
      destination: Cartesian3.fromDegrees(CesiumMath.toDegrees(c.longitude), 22, this.homeAlt()),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      duration,
    });
  }

  /**
   * Flies straight down over the midpoint of a and b, high enough that both fit
   * in the part of the canvas not covered by the result card (bottomInset: 0..1).
   */
  private frame(a: { lon: number; lat: number }, b: { lon: number; lat: number }, bottomInset: number, minAlt = 60_000, duration = 1.8) {
    const camera = this.scene.camera;
    const geod = new EllipsoidGeodesic(
      Cartographic.fromDegrees(a.lon, a.lat),
      Cartographic.fromDegrees(b.lon, b.lat),
    );
    const d = geod.surfaceDistance || 0;
    const mid = geod.interpolateUsingFraction(0.5);
    const canvas = this.scene.canvas;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const fov = (camera.frustum as unknown as { fov?: number }).fov ?? CesiumMath.PI_OVER_THREE;
    // Cesium's fov spans the larger canvas side.
    const tanBig = Math.tan(fov / 2);
    const tanV = aspect >= 1 ? tanBig / aspect : tanBig;
    const tanH = aspect >= 1 ? tanBig : tanBig * aspect;
    const avail = Math.max(0.35, 1 - bottomInset);
    const span = Math.max(d, 1) * 1.45;
    let alt = Math.max(span / (2 * tanV * avail), span / (2 * tanH), minAlt, this.closestAlt());
    let lat = CesiumMath.toDegrees(mid.latitude);
    if (alt < 5e6) {
      // Push the pair up into the free area above the card.
      const visibleV = 2 * alt * tanV;
      lat -= ((bottomInset / 2) * visibleV) / 111_320;
    } else {
      alt = Math.min(alt * 1.1, 2.4e7);
    }
    camera.flyTo({
      destination: Cartesian3.fromDegrees(CesiumMath.toDegrees(mid.longitude), Math.max(-85, lat), alt),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      duration,
    });
  }
}
