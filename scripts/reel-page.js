// In-page runtime for scripts/make-reel-formats.mjs: injected into the running game page
// (vite preview), it hides the game's UI, keeps the globe, and draws each reel format as
// HTML over it. The node script calls __reel.setup(cfg) once and __reel.frame(t) per frame.
//
// Headless Chrome on the graphics card drops CSS gradients, blurs and shadows, so text
// sits on flat translucent panels and any shading is baked into CPU canvases.
(() => {
  const W = 1080, H = 1920;
  const SAFE_TOP = 170, SAFE_BOTTOM = 430;  // Instagram's header, and its caption and buttons
  const GOLD = '#e3b261';
  const R_EARTH = 6_378_137, DEG_M = 111_320, TAN = Math.tan(Math.PI / 6);

  // ---------- helpers ----------
  const clamp = (u) => Math.max(0, Math.min(1, u));
  const ease = (u) => u * u * (3 - 2 * u);
  const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const logLerp = (a, z, u) => Math.exp(Math.log(a) + (Math.log(z) - Math.log(a)) * u);
  const ramp = (t, a, d = 0.3) => clamp((t - a) / d);           // 0 → 1 from a over d seconds
  const win = (t, a, z, d = 0.3) => Math.min(ramp(t, a, d), 1 - ramp(t, z - d, d)); // in at a, out by z
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const el = (html, parent) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const n = t.content.firstChild;
    (parent ?? root).append(n);
    return n;
  };
  const show = (n, o, dy = 0, s = 1) => {
    n.style.opacity = o;
    n.style.transform = `translateY(${(1 - o) * dy}px) scale(${s})`;
  };
  const img = async (src) => { const im = new Image(); im.src = src; await im.decode(); return im; };
  // A CPU canvas (the GPU one drops gradients and filters in headless Chrome).
  const canvas = (w, h, parent, css = '') => {
    const c = el(`<canvas width="${w}" height="${h}" style="position:absolute;${css}"></canvas>`, parent);
    return [c, c.getContext('2d', { willReadFrequently: true })];
  };
  // Draws the 9:16 (or w:h) window centred at (cx, cy) with width wf (fractions of the photo).
  const drawWindow = (g, im, cx, cy, wf, w, h) => {
    const nw = im.naturalWidth, nh = im.naturalHeight;
    let rw = wf * nw, rh = (rw * h) / w;
    if (rh > nh) { rh = nh; rw = (rh * w) / h; }
    const x0 = Math.max(0, Math.min(nw - rw, cx * nw - rw / 2)), y0 = Math.max(0, Math.min(nh - rh, cy * nh - rh / 2));
    g.drawImage(im, x0, y0, rw, rh, 0, 0, w, h);
  };
  // Cover-fit a photo into a w×h tile (optionally around a focus point), baked to a data URL.
  const tile = (im, w, h, fx = 0.5, fy = 0.5, zoom = 1) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    const nw = im.naturalWidth, nh = im.naturalHeight;
    const s = Math.max(w / nw, h / nh) * zoom;
    const rw = w / s, rh = h / s;
    const x0 = Math.max(0, Math.min(nw - rw, fx * nw - rw / 2)), y0 = Math.max(0, Math.min(nh - rh, fy * nh - rh / 2));
    g.drawImage(im, x0, y0, rw, rh, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.93);
  };

  // ---------- the globe ----------
  let scene, C3, Hc = H, canvasTop = 0;
  const globeEl = () => document.getElementById('globe');
  // Moves the globe's centre to screen y = cy: the canvas is made taller and shifted, since
  // the camera always looks at the canvas centre.
  function placeGlobe(cy) {
    Hc = Math.round(H + 2 * Math.abs(cy - H / 2));
    canvasTop = Math.round(cy - Hc / 2);
    const e = globeEl();
    e.style.setProperty('top', canvasTop + 'px', 'important');
    e.style.setProperty('height', Hc + 'px', 'important');
    window.__landmarked.globe.widget.resize();
  }
  // Camera height at which the whole globe is `r` pixels in radius.
  const altFor = (r) => R_EARTH / Math.sin(Math.atan((r * TAN) / (Hc / 2))) - R_EARTH;
  // Height at which `km` of ground spans `px` pixels across.
  const altSpan = (km, px) => (km * 1000 * Hc) / (2 * TAN * px);
  function cam(lon, lat, alt) {
    scene.camera.setView({ destination: C3.fromDegrees(lon, lat, alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }
  function project(lon, lat) {
    const p = scene.cartesianToCanvasCoordinates(C3.fromDegrees(lon, lat, 0));
    return p ? { x: p.x, y: p.y + canvasTop } : { x: -999, y: -999 };
  }
  // The neutral spin (over Europe and Africa at the start) used behind text formats: it
  // says nothing about any answer.
  const neutral = (t, speed = -10) => cam(30 + speed * t, 18, NEUTRAL_ALT);
  let NEUTRAL_ALT = 1e7;

  // ---------- shared pieces ----------
  let root;
  const CSS = `
    body > * { visibility: hidden; }
    body { background: #0e1012 !important; }
    #globe { visibility: visible; position: fixed !important; left: 0 !important; width: 100vw !important; z-index: 10; }
    #globe .pins { display: none; }
    #reel { visibility: visible; position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: ReelPlex, monospace; color: #ece6da; overflow: hidden; }
    #reel .abs { position: absolute; }
    #reel .rpanel { background: rgb(10 12 14 / 0.78); border-radius: 26px; }
    #reel .gold { color: ${GOLD}; }
    #reel .title { position: absolute; left: 60px; right: 60px; text-align: center; font-weight: 600; color: ${GOLD}; font-size: 76px; line-height: 1.12; }
    #reel .title span { display: inline-block; padding: 6px 30px 12px; }
    #reel .rbig { font-size: 46px; line-height: 1.32; font-weight: 600; }
    #reel .rmid { font-size: 40px; line-height: 1.34; font-weight: 600; }
    #reel .cta { position: absolute; left: 70px; right: 70px; text-align: center; font-size: 42px; font-weight: 600; line-height: 1.3; }
    #reel .cta span { display: inline-block; padding: 16px 32px; border: 3px solid ${GOLD}; border-radius: 999px; background: rgb(10 12 14 / 0.86); }
    #reel .brand { position: absolute; left: 0; right: 0; text-align: center; font-size: 30px; letter-spacing: 0.06em; color: ${GOLD}; }
    #reel .brand span { display: inline-block; padding: 6px 20px; background: rgb(10 12 14 / 0.7); border-radius: 999px; }
    #reel .dim { position: absolute; inset: 0; background: rgb(8 9 11 / 0.45); }
    #reel .badge { display: inline-block; font-size: 30px; font-weight: 600; color: #15110a; background: ${GOLD}; border-radius: 10px; padding: 2px 14px; margin-bottom: 10px; }
    #reel .pinx { position: absolute; left: 0; top: 0; width: 92px; height: 122px; margin: -122px 0 0 -46px; filter: none; }
    #reel .pinx text { font: 600 15px ReelPlex, monospace; }
    #reel .emoji { font-family: 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif; }
  `;
  // A brand line just above Instagram's caption area: the path to the site, on every frame.
  const brand = (text = 'landmarked.land · 5 buildings a day') => el(`<div class="brand" style="bottom:${SAFE_BOTTOM + 12}px"><span>${esc(text)}</span></div>`);
  const title = (html, top = SAFE_TOP, size) => el(`<div class="title" style="top:${top}px;${size ? `font-size:${size}px` : ''}"><span class="rpanel">${html}</span></div>`);
  const cta = (text, bottom = SAFE_BOTTOM + 80) => el(`<div class="cta" style="bottom:${bottom}px"><span>${esc(text)}</span></div>`);

  // ---------- the formats ----------
  const F = {};

  // 1. zoom-out: a macro detail slowly widens; it stops before the whole building shows,
  // then snaps back in, so the loop is seamless. A seconds counter makes it a race.
  F.zoomout = {
    total: 12,
    async setup(c) {
      globeEl().style.visibility = 'hidden';
      this.im = await img(c.photo);
      [this.cv, this.g] = canvas(W, H, root, 'left:0;top:0');
      this.title = title(esc(c.hook), SAFE_TOP, 64);
      this.count = el(`<div class="abs" style="right:60px;top:${SAFE_TOP + 190}px;font-size:96px;font-weight:600;color:${GOLD}"><span class="rpanel" style="padding:4px 26px;display:inline-block">0s</span></div>`);
      this.cta = cta(c.cta);
      this.brand = brand();
      this.c = c;
    },
    frame(t) {
      const { from, to } = this.c, OUT = 9.4, BACK = 11.2;
      let u;
      if (t < OUT) u = ease(t / OUT) * 0.35 + (t / OUT) * 0.65;   // nearly steady, a soft start and stop
      else if (t < BACK) u = 1;
      else u = 1 - easeInOut((t - BACK) / (this.total - BACK));
      const wf = logLerp(from[2], to[2], u);
      const k = (Math.log(wf) - Math.log(from[2])) / (Math.log(to[2]) - Math.log(from[2]));
      drawWindow(this.g, this.im, from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, wf, W, H);
      const sec = Math.min(9, Math.floor(t) + 1);
      this.count.firstChild.textContent = `${sec}s`;
      this.count.style.opacity = t < OUT ? 1 : 0;
      show(this.cta, win(t, OUT, BACK + 0.2), 30);
    },
  };

  // 2. ladder: three clues, hardest first, worth 3, 2 and 1 points.
  F.ladder = {
    total: 14.4,
    async setup(c) {
      placeGlobe(H / 2); NEUTRAL_ALT = altFor(560);
      el('<div class="dim"></div>');
      this.title = title(esc(c.hook), SAFE_TOP, 62);
      const top = SAFE_TOP + this.title.offsetHeight + 40;
      this.cards = c.clues.map((txt, i) => el(`<div class="abs rpanel rmid" style="left:60px;right:60px;padding:22px 34px 26px">
        <div class="badge">${c.points[i]}</div><div>${esc(txt)}</div></div>`));
      let y = top;
      for (const card of this.cards) { card.style.top = y + 'px'; y += card.offsetHeight + 26; }
      this.cta = cta(c.cta);
      this.brand = brand();
      this.at = [0.9, 4.8, 8.7];
    },
    frame(t) {
      neutral(t);
      const end = this.total - 0.5;
      this.cards.forEach((card, i) => {
        const o = win(t, this.at[i], end, 0.35);
        show(card, o, 40);
        const next = this.at[i + 1];
        card.style.filter = '';
        card.firstElementChild.style.background = next !== undefined && t > next ? '#6d6450' : '';
      });
      show(this.cta, win(t, 12.0, end, 0.3), 30);
    },
  };

  // 3. pins: four numbered pins on the globe and one clue: which one is it?
  F.pins = {
    total: 12,
    async setup(c) {
      this.title = title(esc(c.hook), SAFE_TOP, 70);
      const clueTop = SAFE_TOP + this.title.offsetHeight + 24;
      this.clue = el(`<div class="abs rpanel rbig" style="left:60px;right:60px;top:${clueTop}px;padding:22px 34px;text-align:center">${esc(c.clue)}</div>`);
      this.cta = cta(c.cta);
      this.brand = brand();
      const top = clueTop + this.clue.offsetHeight + 30, bottom = H - SAFE_BOTTOM - 170;
      placeGlobe((top + bottom) / 2);
      this.home = altFor(Math.min((bottom - top) / 2, 480));
      // Close enough that the pins spread across the screen, not so close that NASA's tiles blur.
      const lats = c.pins.map((p) => p.lat), lons = c.pins.map((p) => p.lon);
      this.lat = (Math.min(...lats) + Math.max(...lats)) / 2;
      this.lon = (Math.min(...lons) + Math.max(...lons)) / 2;
      const spanKm = Math.max((Math.max(...lons) - Math.min(...lons)) * 111 * Math.cos((this.lat * Math.PI) / 180), (Math.max(...lats) - Math.min(...lats)) * 111 * (W / (bottom - top)));
      this.close = Math.max(2.6e6, altSpan(spanKm, W - 360));
      this.pins = c.pins.map((p, i) => el(`<svg class="pinx" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.8 1 11.8 1 20.2 12 31 12 31s11-10.8 11-19.2C23 5.8 18.1 1 12 1z" fill="${GOLD}" stroke="#1a1408" stroke-width="1"/><circle cx="12" cy="11.6" r="6.4" fill="#1a1408"/><text x="12" y="16.8" text-anchor="middle" fill="${GOLD}">${i + 1}</text></svg>`));
      this.c = c;
    },
    frame(t) {
      const IN0 = 0.6, IN1 = 2.8, OUT0 = 10.6;
      let k;
      if (t < IN0) k = 0; else if (t < IN1) k = easeInOut((t - IN0) / (IN1 - IN0));
      else if (t < OUT0) k = 1; else k = 1 - easeInOut((t - OUT0) / (this.total - OUT0));
      // The whole globe turns to the region while zooming, from the neutral start.
      cam(this.lon + (30 - this.lon) * (1 - ease(Math.min(1, k * 1.6))), 18 + (this.lat - 18) * ease(k), logLerp(this.home, this.close, k));
      this.c.pins.forEach((p, i) => {
        const at = IN1 - 0.2 + i * 0.35;
        const u = clamp((t - at) / 0.45);
        const drop = u < 0.75 ? easeOut(u / 0.75) : 1 - Math.sin(((u - 0.75) / 0.25) * Math.PI) * 0.06;
        const q = project(p.lon, p.lat);
        const o = Math.min(u > 0 ? 1 : 0, 1 - clamp((t - OUT0) / 0.3));
        this.pins[i].style.opacity = o;
        this.pins[i].style.transform = `translate(${q.x}px, ${q.y - (1 - drop) * 300}px)`;
      });
      show(this.cta, win(t, 4.6, OUT0 + 0.3, 0.3), 30);
    },
  };

  // 4. blueprint: the building's edges, found in the photo, drawn in gold line by line
  // from the ground up on a blueprint grid. The photo itself is never shown.
  F.blueprint = {
    total: 12,
    async setup(c) {
      globeEl().style.visibility = 'hidden';
      const im = await img(c.photo);
      const [x, y, w, h] = c.crop.map((v, i) => v * (i % 2 ? im.naturalHeight : im.naturalWidth));
      const top = SAFE_TOP + 150, bottom = H - SAFE_BOTTOM - 190;
      const s = Math.min((bottom - top) / h, 940 / w);
      const dw = Math.round(w * s), dh = Math.round(h * s);
      // Background: dark blueprint with a fine gold grid and a title block.
      const [bg, bgc] = canvas(W, H, root, 'left:0;top:0');
      bgc.fillStyle = '#0b1420'; bgc.fillRect(0, 0, W, H);
      bgc.strokeStyle = 'rgba(227,178,97,0.07)'; bgc.lineWidth = 1;
      for (let gx = 0; gx <= W; gx += 30) { bgc.beginPath(); bgc.moveTo(gx + 0.5, 0); bgc.lineTo(gx + 0.5, H); bgc.stroke(); }
      for (let gy = 0; gy <= H; gy += 30) { bgc.beginPath(); bgc.moveTo(0, gy + 0.5); bgc.lineTo(W, gy + 0.5); bgc.stroke(); }
      bgc.strokeStyle = 'rgba(227,178,97,0.16)';
      for (let gx = 0; gx <= W; gx += 150) { bgc.beginPath(); bgc.moveTo(gx + 0.5, 0); bgc.lineTo(gx + 0.5, H); bgc.stroke(); }
      for (let gy = 0; gy <= H; gy += 150) { bgc.beginPath(); bgc.moveTo(0, gy + 0.5); bgc.lineTo(W, gy + 0.5); bgc.stroke(); }
      // Edge detection at drawing size: grey, a small blur, Sobel, keep the strongest ~13%.
      const [cv, g] = canvas(dw, dh, root, `left:${(W - dw) >> 1}px;top:${top + ((bottom - top - dh) >> 1)}px`);
      g.drawImage(im, x, y, w, h, 0, 0, dw, dh);
      const src = g.getImageData(0, 0, dw, dh).data;
      const grey = new Float32Array(dw * dh);
      for (let i = 0; i < dw * dh; i++) grey[i] = 0.3 * src[i * 4] + 0.59 * src[i * 4 + 1] + 0.11 * src[i * 4 + 2];
      const blur = new Float32Array(dw * dh);
      for (let yy = 1; yy < dh - 1; yy++) for (let xx = 1; xx < dw - 1; xx++) {
        let sum = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += grey[(yy + j) * dw + xx + i] * (i === 0 && j === 0 ? 4 : i === 0 || j === 0 ? 2 : 1);
        blur[yy * dw + xx] = sum / 16;
      }
      const mag = new Float32Array(dw * dh);
      for (let yy = 3; yy < dh - 3; yy++) for (let xx = 3; xx < dw - 3; xx++) {
        const p = (i, j) => blur[(yy + j) * dw + xx + i];
        const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
        const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
        mag[yy * dw + xx] = Math.hypot(gx, gy);
      }
      const sorted = Array.from(mag).filter((v) => v > 0).sort((a, z) => a - z);
      const lo = sorted[Math.floor(sorted.length * (1 - (c.keep ?? 0.13)))], hi = sorted[Math.floor(sorted.length * 0.995)];
      // Each line pixel gets a moment to appear: from the ground up, with some jitter so
      // it reads as being drawn rather than wiped.
      this.px = [];
      let seed = 7;
      const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32);
      for (let i = 0; i < dw * dh; i++) {
        if (mag[i] < lo) continue;
        const a = Math.min(1, (mag[i] - lo) / (hi - lo) + 0.25);
        const yy = Math.floor(i / dw);
        this.px.push([i, a, (1 - yy / dh) * 0.82 + rnd() * 0.18]);
      }
      this.out = g.createImageData(dw, dh);
      this.g = g; this.cv = cv;
      this.title = title(esc(c.hook), SAFE_TOP, 66);
      el(`<div class="abs" style="right:70px;bottom:${SAFE_BOTTOM + 70}px;font-size:24px;line-height:1.5;color:${GOLD};opacity:0.8;text-align:right;border:2px solid rgba(227,178,97,0.6);padding:10px 16px">SHEET 1/1 · ELEVATION<br>DRAWN BY landmarked.land</div>`);
      this.cta = cta(c.cta, SAFE_BOTTOM + 190);
    },
    frame(t) {
      const DRAW = 8.4, FADE0 = 11.2;
      const p = easeInOut(clamp(t / DRAW)) * 1.02;
      const fade = 1 - clamp((t - FADE0) / (this.total - FADE0));
      const d = this.out.data;
      d.fill(0);
      for (const [i, a, at] of this.px) {
        if (at > p) continue;
        const fresh = clamp((p - at) / 0.04);     // the newest strokes glow brighter
        d[i * 4] = 227 + 28 * (1 - fresh); d[i * 4 + 1] = 178 + 60 * (1 - fresh); d[i * 4 + 2] = 97 + 120 * (1 - fresh);
        d[i * 4 + 3] = 255 * a * fade;
      }
      this.g.putImageData(this.out, 0, 0);
      show(this.cta, win(t, DRAW - 0.2, this.total - 0.3, 0.3), 30);
    },
  };

  // 5. emoji: three landmarks as emoji riddles, one after another.
  F.emoji = {
    total: 12.6,
    async setup(c) {
      placeGlobe(H / 2); NEUTRAL_ALT = altFor(560);
      el('<div class="dim"></div>');
      this.title = title(esc(c.hook), SAFE_TOP, 70);
      let y = SAFE_TOP + this.title.offsetHeight + 50;
      this.rows = c.riddles.map((r, i) => {
        const n = el(`<div class="abs rpanel" style="left:90px;right:90px;top:${y}px;padding:18px 30px;display:flex;align-items:center;gap:30px">
          <div style="font-size:64px;font-weight:600;color:${GOLD};width:60px">${i + 1}</div><div class="emoji" style="font-size:118px;line-height:1.15;letter-spacing:6px">${r}</div></div>`);
        y += n.offsetHeight + 34;
        return n;
      });
      this.cta = cta(c.cta);
      this.brand = brand();
      this.at = [0.5, 3.0, 5.5];
    },
    frame(t) {
      neutral(t);
      this.rows.forEach((r, i) => { const o = win(t, this.at[i], this.total - 0.4, 0.3); show(r, o, 0, 0.85 + 0.15 * easeOut(o)); });
      show(this.cta, win(t, 8.2, this.total - 0.4), 30);
    },
  };

  // 6. lie: a named building, three statements, one false.
  F.lie = {
    total: 13,
    async setup(c) {
      globeEl().style.visibility = 'hidden';
      const im = await img(c.photo);
      this.title = title(esc(c.hook), SAFE_TOP - 10, 64);
      const pt = SAFE_TOP + this.title.offsetHeight + 10, ph = 470;
      const box = el(`<div class="abs" style="left:0;right:0;top:${pt}px;height:${ph}px;overflow:hidden"></div>`);
      this.ph = el(`<img src="${tile(im, W, ph, c.focus?.[0] ?? 0.5, c.focus?.[1] ?? 0.5, 1)}" style="width:${W}px;height:${ph}px;transform-origin:50% 60%">`, box);
      el(`<div class="abs rpanel" style="left:50%;bottom:20px;transform:translateX(-50%);padding:8px 26px;font-size:40px;font-weight:600;color:${GOLD};white-space:nowrap">${esc(c.name)}</div>`, box);
      let y = pt + ph + 30;
      this.st = c.statements.map((s, i) => {
        const n = el(`<div class="abs rpanel rmid" style="left:50px;right:110px;top:${y}px;padding:16px 26px;display:flex;gap:22px"><b class="gold" style="font-size:46px">${'ABC'[i]}</b><div>${esc(s)}</div></div>`);
        y += n.offsetHeight + 18;
        return n;
      });
      this.cta = cta(c.cta, SAFE_BOTTOM + 56);
      this.at = [1.0, 3.4, 5.8];
    },
    frame(t) {
      this.ph.style.transform = `scale(${1 + 0.06 * (t / this.total)})`;
      this.st.forEach((s, i) => show(s, win(t, this.at[i], this.total - 0.3), 40));
      show(this.cta, win(t, 8.6, this.total - 0.3), 30);
    },
  };

  // 7. timeline: four named buildings, put them in order from oldest to newest.
  F.timeline = {
    total: 12,
    async setup(c) {
      globeEl().style.visibility = 'hidden';
      this.title = title(esc(c.hook), SAFE_TOP, 70);
      const sub = el(`<div class="abs rmid" style="left:60px;right:60px;text-align:center;top:${SAFE_TOP + this.title.offsetHeight + 10}px">${esc(c.sub)}</div>`);
      const top = SAFE_TOP + this.title.offsetHeight + sub.offsetHeight + 40, S = 400, G = 20;
      this.tiles = [];
      for (const [i, b] of c.items.entries()) {
        const im = await img(b.photo);
        const x = (W - 2 * S - G) / 2 + (i % 2) * (S + G), y = top + Math.floor(i / 2) * (S + 90 + G);
        const n = el(`<div class="abs" style="left:${x}px;top:${y}px;width:${S}px">
          <div style="width:${S}px;height:${S}px;border-radius:22px;overflow:hidden;border:3px solid rgba(227,178,97,0.6)"><img src="${tile(im, S, S, b.focus?.[0] ?? 0.5, b.focus?.[1] ?? 0.5)}" style="width:100%;height:100%"></div>
          <div style="margin-top:12px;font-size:34px;font-weight:600;text-align:center;white-space:nowrap"><b class="gold" style="font-size:44px;margin-right:12px">${'ABCD'[i]}</b>${esc(b.name)}</div></div>`);
        this.tiles.push(n);
      }
      this.cta = cta(c.cta, SAFE_BOTTOM + 10);
    },
    frame(t) {
      this.tiles.forEach((n) => show(n, 1));
      show(this.cta, win(t, 3.0, this.total - 0.2), 30);
    },
  };

  // 8. stop: the globe sweeps round under a gold crosshair; pause when it is on the
  // building. The path is periodic, so the loop is seamless and every rewatch is a retry.
  F.stop = {
    total: 12,
    async setup(c) {
      this.title = title(esc(c.hook), SAFE_TOP, 62);
      this.clue = el(`<div class="abs rpanel rmid" style="left:60px;right:60px;top:${SAFE_TOP + this.title.offsetHeight + 20}px;padding:20px 30px;text-align:center">${esc(c.clue)}</div>`);
      // The globe fills the space below the title; the clue panel and the call to comment sit over its edges.
      const top = SAFE_TOP + this.title.offsetHeight + 20;
      this.cy = (top + H - SAFE_BOTTOM) / 2 + 40;
      placeGlobe(this.cy);
      this.alt = altFor(470);
      el(`<svg class="abs" style="left:${W / 2 - 70}px;top:${this.cy - 70}px" width="140" height="140" viewBox="0 0 140 140" fill="none" stroke="${GOLD}" stroke-width="5">
        <circle cx="70" cy="70" r="34"/><line x1="70" y1="0" x2="70" y2="26"/><line x1="70" y1="114" x2="70" y2="140"/><line x1="0" y1="70" x2="26" y2="70"/><line x1="114" y1="70" x2="140" y2="70"/><circle cx="70" cy="70" r="3" fill="${GOLD}"/></svg>`);
      this.cta = cta(c.cta, SAFE_BOTTOM + 70);
      this.c = c;
    },
    frame(t) {
      const { lon, lat, at } = this.c, T = this.total;
      // One full turn per loop, the latitude swinging north and south twice; both pass
      // through the building at `at` seconds (never marked).
      const ph = (2 * Math.PI * (t - at)) / T;
      cam(lon + (360 * (t - at)) / T, Math.max(-62, Math.min(66, lat * Math.cos(2 * ph) + 22 * Math.sin(ph))), this.alt);
    },
  };

  // 9. pick: four places stacked as strips, "one free flight, where?". No wrong answer.
  F.pick = {
    total: 11,
    async setup(c) {
      globeEl().style.visibility = 'hidden';
      this.title = title(esc(c.hook), SAFE_TOP - 10, 60);
      const top = SAFE_TOP + this.title.offsetHeight + 10, bottom = H - SAFE_BOTTOM - 120, G = 10;
      const sh = Math.floor((bottom - top - 3 * G) / 4);
      this.strips = [];
      for (const [i, b] of c.items.entries()) {
        const im = await img(b.photo);
        const n = el(`<div class="abs" style="left:0;right:0;top:${top + i * (sh + G)}px;height:${sh}px;overflow:hidden">
          <img src="${tile(im, W + 120, sh, b.focus?.[0] ?? 0.5, b.focus?.[1] ?? 0.5)}" style="height:${sh}px;width:${W + 120}px">
          <div class="abs rpanel" style="left:30px;bottom:18px;padding:6px 22px;font-size:38px;font-weight:600;white-space:nowrap"><b class="gold" style="font-size:50px;margin-right:14px">${'ABCD'[i]}</b>${esc(b.label)}</div></div>`);
        this.strips.push(n);
      }
      this.cta = cta(c.cta, SAFE_BOTTOM + 40);
    },
    frame(t) {
      // Strips pan in alternate directions; a full cycle per loop so it joins up.
      this.strips.forEach((n, i) => {
        const dir = i % 2 ? 1 : -1;
        n.firstElementChild.style.transform = `translateX(${-60 + dir * 60 * Math.sin((2 * Math.PI * t) / this.total)}px)`;

      });
      show(this.cta, win(t, 2.2, this.total - 0.2), 30);
    },
  };

  // 10. speed: five close-ups, two seconds each, then "how many did you get?".
  F.speed = {
    total: 12.6,
    async setup(c) {
      placeGlobe(H / 2); NEUTRAL_ALT = altFor(500);
      el('<div class="dim"></div>');
      this.shots = [];
      for (const s of c.shots) {
        const im = await img(s.photo);
        const [cv, g] = canvas(W, H, root, 'left:0;top:0;opacity:0');
        drawWindow(g, im, s.crop[0], s.crop[1], s.crop[2] * 1.06, W, H);
        this.shots.push({ cv, g, im, crop: s.crop });
      }
      this.title = title(esc(c.hook), SAFE_TOP, 60);
      this.n = el(`<div class="abs" style="left:60px;top:${SAFE_TOP + 170}px;font-size:84px;font-weight:600;color:${GOLD}"><span class="rpanel" style="padding:2px 24px;display:inline-block">1/5</span></div>`);
      this.bar = el(`<div class="abs" style="left:60px;right:60px;bottom:${SAFE_BOTTOM + 70}px;height:14px;border-radius:7px;background:rgb(10 12 14 / 0.6)"><div style="height:100%;width:100%;border-radius:7px;background:${GOLD};transform-origin:0 50%"></div></div>`);
      this.end = el(`<div class="abs" style="left:60px;right:60px;top:760px;text-align:center"><div class="rpanel" style="display:inline-block;padding:26px 40px;font-size:60px;font-weight:600;line-height:1.25">How many<br>did you get?</div></div>`);
      this.cta = cta(c.cta);
      this.brand = brand();
    },
    frame(t) {
      neutral(t);
      const D = 2, END = 5 * D;
      const k = Math.min(4, Math.floor(t / D));
      this.shots.forEach((s, i) => {
        const on = t < END && i === k;
        s.cv.style.opacity = on ? 1 : 0;
        if (on) { const u = (t - i * D) / D; drawWindow(s.g, s.im, s.crop[0], s.crop[1], s.crop[2] * (1.06 - 0.06 * u), W, H); }
      });
      this.n.firstChild.textContent = `${k + 1}/5`;
      this.n.style.opacity = t < END ? 1 : 0;
      this.bar.style.opacity = t < END ? 1 : 0;
      this.bar.firstChild.style.transform = `scaleX(${1 - ((t % D) / D)})`;
      show(this.end, t >= END ? win(t, END, this.total, 0.25) : 0, 30);
      show(this.cta, t >= END ? win(t, END + 0.2, this.total, 0.25) : 0, 30);
      this.title.style.opacity = 1;
      this.brand.style.opacity = 1;
    },
  };

  window.__reel = {
    async setup(name, c, fonts) {
      const css = document.createElement('style');
      css.textContent = `@font-face { font-family: ReelPlex; font-weight: 400; src: url(data:font/woff2;base64,${fonts.regular}) format('woff2'); }
        @font-face { font-family: ReelPlex; font-weight: 600; src: url(data:font/woff2;base64,${fonts.semi}) format('woff2'); }` + CSS;
      document.head.append(css);
      document.getElementById('intro').hidden = true;
      root = document.createElement('div');
      root.id = 'reel';
      document.body.append(root);
      await document.fonts.ready;
      const g = window.__landmarked.globe;
      scene = g.widget.scene;
      C3 = scene.camera.position.constructor;
      scene.screenSpaceCameraController.minimumZoomDistance = 1;
      g.closestAlt = () => 1;
      placeGlobe(H / 2);
      this.f = F[name];
      await this.f.setup(c);
      return { total: this.f.total, globe: globeEl().style.visibility !== 'hidden' };
    },
    frame(t) {
      this.f.frame(t);
      // Hide the country-code labels (they load after the page starts).
      for (let i = 0; i < scene.primitives.length; i++) {
        const q = scene.primitives.get(i);
        if (q && typeof q.get === 'function' && q.length > 0 && typeof q.get(0)?.text === 'string') q.show = false;
      }
      scene.requestRender();
      scene.render();
    },
  };
})();
