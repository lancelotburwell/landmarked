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

const HOME_ALT = 1.6e7; // m, whole globe in view
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

export class Globe {
  readonly widget: CesiumWidget;
  private points: PointPrimitiveCollection;
  private flags: BillboardCollection;
  private labels: LabelCollection;
  private lines: Primitive[] = [];
  private pending?: ReturnType<PointPrimitiveCollection['add']>;
  private clickCb?: (lon: number, lat: number) => void;
  private flagImages = new Map<string, HTMLCanvasElement>();
  /** Resolves when the first full set of tiles has been drawn. */
  readonly tilesLoaded: Promise<void>;

  constructor(el: HTMLElement, creditEl: HTMLElement, imagery: Imagery = 'eox') {
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
    });
    this.widget = widget;
    // Sharp on retina, but never render more than 2× (phones have 3×).
    widget.resolutionScale = Math.min(dpr, 2) / dpr;

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
      layers.addImageryProvider(
        new UrlTemplateImageryProvider({
          url: `${GIBS}/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
          tilingScheme: new WebMercatorTilingScheme(),
          maximumLevel: 8,
          credit: new Credit(NASA_CREDIT, true),
        }),
      );
      // 3. Landsat WELD annual composite (year 2000), ~30-40 m/px, public domain.
      // Only on close-ups: zoomed out, its no-data gaps show as dark blocks over the sea.
      layers.add(
        new ImageryLayer(new UrlTemplateImageryProvider({
          url: `${GIBS}/Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/2000-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpg`,
          tilingScheme: new WebMercatorTilingScheme(),
          maximumLevel: 12,
        }), { minimumTerrainLevel: 8 }),
      );
    }

    const globe = scene.globe;
    globe.baseColor = Color.fromCssColorString('#0a1622');
    globe.enableLighting = true;
    globe.showGroundAtmosphere = true;
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
    ctrl.minimumZoomDistance = 15_000; // Sentinel-2 tops out at ~10 m/px; closer is just blur
    ctrl.maximumZoomDistance = 4.0e7;

    // Start over the player's own longitude (from their time zone), mid-latitudes.
    const lon = Math.max(-170, Math.min(170, (-new Date().getTimezoneOffset() / 60) * 15));
    scene.camera.setView({ destination: Cartesian3.fromDegrees(lon, 22, HOME_ALT) });

    this.points = scene.primitives.add(new PointPrimitiveCollection());
    this.flags = scene.primitives.add(new BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new LabelCollection({ scene }));

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

  private addFlag(lon: number, lat: number, name: string, color: string) {
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
    this.labels.add({
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
    for (const l of this.lines) this.scene.primitives.remove(l);
    this.lines = [];
    this.render();
  }

  /** Guess dot, flag on the real spot, dashed line between, camera framing both. */
  showResult(m: Marker & { guess: { lon: number; lat: number } }, bottomInset = 0) {
    this.clear();
    this.addDashedLine(m.guess, m);
    this.addGuessDot(m.guess.lon, m.guess.lat);
    this.addFlag(m.lon, m.lat, m.name, m.color);
    this.frame(m.guess, m, bottomInset);
  }

  /** All of today's buildings, with the player's guesses. */
  showAll(markers: Marker[]) {
    this.clear();
    for (const m of markers) {
      if (m.guess) {
        this.addDashedLine(m.guess, m);
        this.addGuessDot(m.guess.lon, m.guess.lat);
      }
      this.addFlag(m.lon, m.lat, m.name, m.color);
    }
    this.flyHome();
  }

  flyHome(duration = 1.6) {
    const c = this.scene.camera.positionCartographic;
    this.scene.camera.flyTo({
      destination: Cartesian3.fromDegrees(CesiumMath.toDegrees(c.longitude), 22, HOME_ALT),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      duration,
    });
  }

  /**
   * Flies straight down over the midpoint of a and b, high enough that both fit
   * in the part of the canvas not covered by the result card (bottomInset: 0..1).
   */
  private frame(a: { lon: number; lat: number }, b: { lon: number; lat: number }, bottomInset: number) {
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
    let alt = Math.max(span / (2 * tanV * avail), span / (2 * tanH), 60_000);
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
      duration: 1.8,
    });
  }
}
