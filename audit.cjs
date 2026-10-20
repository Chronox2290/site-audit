#!/usr/bin/env node
// Site audit: loads each page at phone, tablet and desktop widths in a headless
// Chromium browser (Edge, Chrome or Playwright's own) and checks everything a careful reviewer would, so problems are found
// before anyone else sees them. Prints FAIL / WARN lines and writes a JSON
// report plus full-page screenshots for the visual pass.
//
//   node audit.cjs <base-url> [out-dir] [--paths /,/about] [--no-click] [--no-efficiency]
//                  [--ignore file] [--browser msedge|chrome|chromium]
//
// Checks per width: page and console errors, failed requests, sideways
// scroll, upscaled (blurry) and oversized images, canvases drawn below the
// screen's density, clipped or overflowing text, overlapping text, small tap
// targets and text, missing alt text, heading structure, layout shift, axe
// accessibility (serious and critical), and, unless --no-click, every button
// pressed once to find controls that change nothing. Once per site: meta
// tags, viewport zoom, links, sitemap and robots.
//
// Efficiency, once per page unless --no-efficiency, all measured in the
// browser: transfer bytes by type, uncompressed text, heavy and old-format
// images, unused JS and CSS (coverage), render-blocking head scripts and
// styles, DOM size, main thread work while idle, and first paint, largest
// paint and total blocking time on a 412 px phone with the CPU slowed 4x.
// WebGL, on any library: draw calls and triangles per frame, texture sizes
// and memory, drawing while idle or scrolled away, and canvases drawn above
// 2x on a phone. Video: each file's codec, bit depth, colour range and
// bitrate (with ffprobe), and whether the picture on screen matches the
// decoded frame. Numbers also go to <out-dir>/efficiency.json.
const path = require('path');
const fs = require('fs');
// playwright or playwright-core, installed next to this file or globally
const globalRoot = () => { try { return require('child_process').execSync('npm root -g').toString().trim(); } catch { return ''; } };
const need = (name) => { try { return require(name); } catch { return require(path.join(globalRoot(), name)); } };
let playwright;
try { playwright = need('playwright'); } catch { playwright = need('playwright-core'); }
const { chromium } = playwright;

const args = process.argv.slice(2);
const BASE = (args[0] || '').replace(/\/$/, '');
if (!BASE) { console.error('usage: node audit.cjs <base-url> [out-dir] [--paths /,/a] [--no-click] [--no-efficiency] [--ignore file] [--browser msedge|chrome|chromium]'); process.exit(2); }
const OUT = args[1] && !args[1].startsWith('--') ? args[1] : path.join(process.cwd(), 'site-audit');
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// Git Bash rewrites a bare /path into a Windows path: take the part after Git/
const PATHS = val('--paths', '/').split(',').map((x) => (x.match(/Git(\/.*)$/) || [null, x])[1] || '/').map((x) => (x.startsWith('/') ? x : '/' + x));
const CLICK = !flag('--no-click');
const EFFICIENCY = !flag('--no-efficiency');
// a project's .site-audit-ignore.json: [{ "selector": "...", "reason": "how it was checked instead" }]
const IGNORE_FILE = val('--ignore', path.join(process.cwd(), '.site-audit-ignore.json'));
const IGNORE = fs.existsSync(IGNORE_FILE) ? JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')) : [];
if (IGNORE.length) console.log(`ignoring ${IGNORE.length} selector(s) from ${IGNORE_FILE}:\n` + IGNORE.map((x) => `  ${x.selector}: ${x.reason}`).join('\n'));
const WIDTHS = [
  { name: 'phone-360', w: 360, h: 780, mobile: true, dpr: 3 },
  { name: 'phone-412', w: 412, h: 915, mobile: true, dpr: 3.5 },
  { name: 'tablet-820', w: 820, h: 1180, mobile: true, dpr: 2 },
  { name: 'desktop-1440', w: 1440, h: 900, mobile: false, dpr: 1 },
  { name: 'desktop-1920', w: 1920, h: 1080, mobile: false, dpr: 1 },
  { name: 'desktop-2560', w: 2560, h: 1440, mobile: false, dpr: 1.5 },
];
let AXE = null;
let AXE_SRC = '';
try { AXE = require.resolve('axe-core/axe.min.js'); } catch { try { AXE = require.resolve(path.join(globalRoot(), 'axe-core/axe.min.js')); } catch { /* axe optional */ } }
if (AXE) AXE_SRC = fs.readFileSync(AXE, "utf8");

const findings = [];
const add = (level, where, check, detail) => { findings.push({ level, where, check, detail }); console.log(`${level} ${where} ${check}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`); };
const metrics = [];
const kb = (b) => Math.round(b / 1024);
const short = (u) => { try { const x = new URL(u); return (x.origin === new URL(BASE).origin ? '' : x.host) + x.pathname.slice(-70); } catch { return String(u).slice(-80); } };

// runs inside the page: every geometry and content check in one pass
const probe = () => {
  const out = { overflowX: 0, images: [], canvases: [], clipped: [], overlaps: [], smallTargets: [], smallText: [], noAlt: [], h1: 0, headings: [], pointerNoRole: [] };
  // visible to a person: rendered, not faded out by any ancestor, not
  // visually hidden (sr-only), not transparent ink
  const vis = (e) => {
    if (e.checkVisibility && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (+s.opacity < 0.05) return false; if (s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(s.clipPath)) return false; }
    const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1;
  };
  const inked = (e) => { const c = getComputedStyle(e).color.match(/[\d.]+/g); return !c || c.length < 4 || +c[3] > 0.05; };
  const painted = (e) => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true; const top = document.elementFromPoint(x, y); return !top || top === e || e.contains(top) || top.contains(e); };
  // the part of a box actually on show: cut by every clipping ancestor
  const shown = (e) => { let r = e.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom; for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none') { const q = a.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } } return { left: L, top: T, right: R, bottom: B, width: Math.max(0, R - L), height: Math.max(0, B - T) }; };
  const ignored = (e) => (window.__auditIgnore || []).some((sel) => { try { return e.matches(sel) || !!e.closest(sel); } catch { return false; } });
  const fixedUp = (e) => { for (let a = e; a; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const label = (e) => { const t = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('alt') || e.className || e.tagName).toString().replace(/\s+/g, ' ').trim(); return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${t.slice(0, 50)}"`; };
  const dpr = devicePixelRatio;
  out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  // images drawn larger than their pixels (blurry) or far smaller (wasted bytes)
  for (const img of document.images) {
    if (!vis(img) || !img.complete || !img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    let drawn = r.width;
    if (fit === 'contain' || fit === 'cover') { const s = fit === 'contain' ? Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) : Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight); drawn = img.naturalWidth * s; }
    const need = drawn * dpr;
    // naturalWidth is divided by the srcset density; the file's real pixel width is stamped before the probe
    const px = +img.dataset.auditPx || img.naturalWidth;
    // a vector stays sharp at any size
    if (/\.svg(\?|#|$)/i.test(img.currentSrc || img.src) || /^data:image\/svg/.test(img.currentSrc || img.src)) continue;
    if (need > px * 1.15 && drawn > 120) out.images.push({ kind: 'upscaled', el: label(img), src: (img.currentSrc || img.src).split('/').pop().slice(0, 80), natural: px, shown: Math.round(drawn), need: Math.round(need) });
    else if (px > need * 3 && px > 600) out.images.push({ kind: 'oversized', el: label(img), src: (img.currentSrc || img.src).split('/').pop().slice(0, 80), natural: px, need: Math.round(need) });
    if (!img.hasAttribute('alt')) out.noAlt.push(label(img));
  }
  // canvases (WebGL scenes, charts) drawn below the screen's density look soft and jagged
  for (const c of document.querySelectorAll('canvas')) {
    if (!vis(c)) continue;
    const r = c.getBoundingClientRect();
    const ratio = c.width / r.width;
    if (r.width > 100 && ratio < Math.min(dpr, 2) * 0.95) out.canvases.push({ el: label(c), backing: c.width, shown: Math.round(r.width), ratio: +ratio.toFixed(2), dpr });
  }
  // leaf text that is cut off by its own box or by a clipping ancestor
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName) && (e.textContent || '').trim().length > 1 && vis(e) && inked(e));
  for (const e of leaves) {
    if (!painted(e)) continue;
    const cs = getComputedStyle(e);
    // a running marquee is meant to run past its window
    if (e.closest('[data-run], marquee, [aria-hidden="true"][class*="marquee"]')) continue;
    if ((cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2)) out.clipped.push({ el: label(e), why: 'own box', sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight });
    const r = e.getBoundingClientRect();
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflow === 'visible' && acs.clipPath === 'none') continue;
      const ar = a.getBoundingClientRect();
      const cut = Math.max(ar.left - r.left, r.right - ar.right, ar.top - r.top, r.bottom - ar.bottom);
      if (cut > 3 && !(acs.overflowX === 'auto' || acs.overflowX === 'scroll' || acs.overflowY === 'auto' || acs.overflowY === 'scroll')) out.clipped.push({ el: label(e), why: 'cut by ' + label(a), by: Math.round(cut) });
      break;
    }
  }
  // text drawn over other text
  // fixed bars sit over content on purpose; text under another layer is not drawn
  const boxes = leaves.filter((e) => !fixedUp(e)).map((e) => ({ e, r: shown(e) })).filter((b) => b.r.width * b.r.height > 20);
  for (let i = 0; i < boxes.length && out.overlaps.length < 40; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 2 || h <= 2) continue;
      const share = (w * h) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      // text wrapping over two lines has a box spanning both: compare its line boxes
      const lines = (e) => [...e.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
      const hit = getComputedStyle(a.e).display === 'inline' || getComputedStyle(b.e).display === 'inline'
        ? lines(a.e).some((p) => lines(b.e).some((q) => { const iw = Math.min(p.right, q.right) - Math.max(p.left, q.left), ih = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top); return iw > 2 && ih > 2 && (iw * ih) / Math.min(p.width * p.height, q.width * q.height) > 0.25; }))
        : true;
      if (hit && share > 0.25 && a.e.textContent.trim() !== b.e.textContent.trim()) out.overlaps.push({ a: label(a.e), b: label(b.e), share: +share.toFixed(2) });
    }
  }
  // tap targets and type size (phones and tablets)
  for (const e of document.querySelectorAll('a[href], button, [role="button"], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')) {
    if (!vis(e) || ignored(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    // WCAG 2.5.8 exempts a link inside a line of text
    if (e.tagName === 'A' && getComputedStyle(e).display === 'inline' && (e.parentElement.textContent || '').trim().length > (e.textContent || '').trim().length + 20) continue;
    // a target can be larger than its box (a ::after ring): probe 12 px out
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hits = [[12, 0], [-12, 0], [0, 12], [0, -12]].filter(([dx, dy]) => { const t = document.elementFromPoint(cx + dx, cy + dy); return t && (t === e || e.contains(t)); }).length;
    if (hits < 4) out.smallTargets.push({ el: label(e), w: Math.round(r.width), h: Math.round(r.height) });
  }
  for (const e of leaves) { const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 11) out.smallText.push({ el: label(e), px: fs }); }
  // things that look clickable but are not controls
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || getComputedStyle(e).cursor !== 'pointer') continue;
    if (e.closest('a, button, [role], label, summary, input, select, textarea, [onclick]')) continue;
    out.pointerNoRole.push(label(e));
    if (out.pointerNoRole.length > 20) break;
  }
  out.h1 = document.querySelectorAll('h1').length;
  out.headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis).map((h) => +h.tagName[1]);
  return out;
};

// runs before any page script: wraps the WebGL contexts themselves, so it
// counts draw calls, triangles and texture uploads for any library. A frame
// is everything drawn between two requestAnimationFrame timestamps.
const glHook = () => {
  const s = (window.__gl = { contexts: 0, draws: 0, tris: 0, frames: [], frameCount: 0, cur: { d: 0, t: 0 }, ts: -1, textures: [] });
  const seen = new WeakSet();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { const c = getContext.call(this, type, ...a); if (c && /webgl/i.test(type) && !seen.has(c)) { seen.add(c); s.contexts++; } return c; };
  const tri = (mode, n, k = 1) => (mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0) * (k || 1);
  const draw = (t, gl) => { s.draws++; s.tris += t; s.cur.d++; s.cur.t += t; if (gl && gl.canvas) gl.canvas.__auditDraws = (gl.canvas.__auditDraws || 0) + 1; };
  const tex = (w, h, levels, kind) => { if (w > 0 && h > 0) s.textures.push({ w, h, levels, kind }); };
  for (const G of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!G) continue;
    const P = G.prototype;
    const hook = (name, fn) => { if (!Object.prototype.hasOwnProperty.call(P, name)) return; const f = P[name]; P[name] = function (...a) { try { fn(a, this); } catch { /* counting must never break the page */ } return f.apply(this, a); }; };
    hook('drawArrays', (a, gl) => draw(tri(a[0], a[2]), gl));
    hook('drawElements', (a, gl) => draw(tri(a[0], a[1]), gl));
    hook('drawArraysInstanced', (a, gl) => draw(tri(a[0], a[2], a[3]), gl));
    hook('drawElementsInstanced', (a, gl) => draw(tri(a[0], a[1], a[4]), gl));
    hook('drawRangeElements', (a, gl) => draw(tri(a[0], a[3]), gl));
    // texImage2D: (target, level, format, w, h, border, ...) or (target, level, format, format, type, source)
    hook('texImage2D', (a) => { if (a[1] !== 0) return; if (a.length >= 9) return tex(a[3], a[4], 1, 'raw'); const x = a[5] || {}; tex(x.naturalWidth || x.videoWidth || x.displayWidth || x.width, x.naturalHeight || x.videoHeight || x.displayHeight || x.height, 1, 'image'); });
    hook('texStorage2D', (a) => tex(a[3], a[4], a[1], 'storage'));
    hook('compressedTexImage2D', (a) => { if (a[1] === 0) tex(a[3], a[4], 1, 'compressed'); });
    hook('texImage3D', (a) => { if (a[1] === 0) tex(a[3], a[4], 1, '3d'); });
    hook('texStorage3D', (a) => tex(a[3], a[4], a[1], '3d'));
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    if (ts !== s.ts) { if (s.cur.d) { s.frames.push(s.cur); s.frameCount++; if (s.frames.length > 3000) s.frames.shift(); } s.cur = { d: 0, t: 0 }; s.ts = ts; }
    return cb(ts);
  });
};
const glRead = () => {
  const s = window.__gl; if (!s) return null;
  const fr = s.frames.concat(s.cur.d ? [s.cur] : []);
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; };
  const d = fr.map((f) => f.d), t = fr.map((f) => f.t);
  return { contexts: s.contexts, draws: s.draws, frames: s.frameCount + (s.cur.d ? 1 : 0), drawsMedian: q(d, 0.5), drawsP95: q(d, 0.95), drawsMax: q(d, 1), trisMedian: q(t, 0.5), trisMax: q(t, 1), textures: s.textures, three: String(window.__THREE__ || '') };
};
// runs inside the page: what the head blocks on, how images are sized and loaded, DOM size
const pageCost = () => {
  const js = (s) => !s.type || /javascript|ecmascript/i.test(s.type);
  const blockingJs = [...document.head.querySelectorAll('script[src]')].filter((s) => js(s) && !s.async && !s.defer && !s.noModule).map((s) => s.src);
  const blockingCss = [...document.head.querySelectorAll('link[rel~="stylesheet"]')].filter((l) => !l.disabled && (!l.media || matchMedia(l.media).matches)).map((l) => l.href);
  const imgs = [...document.images].map((i) => { const r = i.getBoundingClientRect(); return { src: i.currentSrc || i.src, sized: getComputedStyle(i).aspectRatio !== 'auto', below: r.top + scrollY > innerHeight * 1.5, lazy: i.loading === 'lazy', shown: r.width > 0 }; });
  return { blockingJs, blockingCss, imgs, nodes: document.getElementsByTagName('*').length };
};
// share of each script and stylesheet that never ran or matched; V8 block
// ranges nest, so paint the outermost first and let inner ranges override
const jsUsed = (e) => {
  const len = (e.source || '').length; if (!len) return [0, 0];
  const mark = new Uint8Array(len);
  const ranges = e.functions.flatMap((f) => f.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  for (const r of ranges) mark.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
  let used = 0; for (let i = 0; i < len; i++) used += mark[i];
  return [len, used];
};
const cssUsed = (e) => [(e.text || '').length, e.ranges.reduce((n, r) => n + r.end - r.start, 0)];
const taskSeconds = async (cdp) => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'TaskDuration')?.value || 0;

// ---- efficiency and 3D cost of one page ----
// ---- video: the files a page plays and what reaches the screen ----
// ffprobe is optional: without it the format checks are skipped and said so.
let FFPROBE = null;
const ffprobe = (file) => {
  const { execFileSync } = require('child_process');
  if (FFPROBE === null) { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); FFPROBE = true; } catch { FFPROBE = false; } }
  if (!FFPROBE) return null;
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,color_range,r_frame_rate:format=bit_rate', '-of', 'json', file]).toString());
    return j.streams && j.streams[0] ? { ...j.streams[0], bit_rate: +(j.format || {}).bit_rate || 0 } : null;
  } catch { return null; }
};
const frameRate = (r) => { const [a, b] = String(r || '30/1').split('/').map(Number); return b ? a / b : a || 30; };
// mean brightness (0-255) of an image given as a data URL, worked out in the page
const meanLuma = (src) => new Promise((res) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.max(1, Math.round(160 * img.height / img.width));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    res(s / (d.length / 4));
  };
  img.onerror = () => res(null);
  img.src = src;
});
const slug = (p) => (p === '/' ? 'home' : p.replace(/\W+/g, '-').replace(/^-|-$/g, ''));

async function videoPass(browser, p, m) {
  const where = `${p} video`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(3000);
  // a video set to preload nothing has no source chosen yet: ask for its metadata
  const vids = await page.evaluate(async () => {
    const all = [...document.querySelectorAll('video')];
    for (const v of all) if (!v.currentSrc) { v.preload = 'metadata'; v.load(); }
    await new Promise((r) => setTimeout(r, 1500));
    return all.map((v, i) => {
      v.setAttribute('data-audit-video', i);
      const r = v.getBoundingClientRect();
      // a video drawn over by a canvas is still compared; one hidden outright is not
      const hidden = getComputedStyle(v).visibility === 'hidden' || getComputedStyle(v).display === 'none';
      return { i, src: v.currentSrc, shownW: Math.round(r.width), shownH: Math.round(r.height), hidden };
    });
  });
  m.video = [];
  const seen = new Set();
  for (const v of vids) {
    if (!v.src || seen.has(v.src)) continue;
    seen.add(v.src);
    const n = seen.size;
    const row = { src: short(v.src), shown: `${v.shownW}x${v.shownH}` };
    const tmp = path.join(OUT, `video-${n}${path.extname(new URL(v.src).pathname) || '.bin'}`);
    try { fs.writeFileSync(tmp, await (await page.request.get(v.src)).body()); } catch { add('WARN', where, 'video file did not download', short(v.src)); continue; }
    const f = ffprobe(tmp);
    fs.rmSync(tmp, { force: true });
    if (f) {
      const bpp = f.bit_rate / (f.width * f.height * frameRate(f.r_frame_rate));
      Object.assign(row, { codec: f.codec_name, size: `${f.width}x${f.height}`, pix: f.pix_fmt, range: f.color_range, mbps: +(f.bit_rate / 1e6).toFixed(2), bpp: +bpp.toFixed(3) });
      add('INFO', where, 'video file', `${short(v.src)}: ${f.codec_name} ${f.width}x${f.height} ${f.pix_fmt} ${f.color_range || ''} ${(f.bit_rate / 1e6).toFixed(2)} Mbps, shown ${v.shownW}x${v.shownH}`);
      if (/1[02](le|be)?$/.test(f.pix_fmt || '')) add('WARN', where, '10 or 12-bit video (decodes wrongly on some phones and through WebGL; encode 8-bit yuv420p)', `${f.pix_fmt} ${short(v.src)}`);
      if ((f.pix_fmt || '').startsWith('yuvj') || f.color_range === 'pc') add('WARN', where, 'full-range video (encode tv range)', short(v.src));
      if (bpp < 0.02) add('WARN', where, 'video bitrate too low for its size (dark or busy scenes block up)', `${(f.bit_rate / 1e6).toFixed(2)} Mbps for ${f.width}x${f.height}, ${bpp.toFixed(3)} bits per pixel, ${short(v.src)}`);
    } else if (FFPROBE === false && n === 1) add('INFO', where, 'ffprobe not found: video format and bitrate checks skipped');
    // what reaches the screen, against the frame the browser decoded
    if (v.shownW >= 120 && !v.hidden) {
      const fr = await page.evaluate(async (i) => {
        const el = document.querySelector(`[data-audit-video="${i}"]`);
        el.muted = true;
        try { await Promise.race([el.play(), new Promise((r) => setTimeout(r, 3000))]); } catch { return null; }
        await new Promise((r) => setTimeout(r, 1800));
        el.pause();
        if (!el.videoWidth) return null;
        await new Promise((r) => setTimeout(r, 500));
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = Math.round(320 * el.videoHeight / el.videoWidth);
        try { c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); return c.toDataURL('image/png'); } catch { return null; }
      }, v.i);
      if (fr) {
        await page.locator(`[data-audit-video="${v.i}"]`).scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        const clip = await page.evaluate((i) => { const r = document.querySelector(`[data-audit-video="${i}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, v.i);
        const buf = clip.width > 4 && clip.height > 4 ? await page.screenshot({ clip }).catch(() => null) : null;
        if (buf) {
          const decoded = await page.evaluate(meanLuma, fr);
          const screen = await page.evaluate(meanLuma, 'data:image/png;base64,' + buf.toString('base64'));
          if (decoded != null && screen != null) {
            Object.assign(row, { decodedLuma: Math.round(decoded), screenLuma: Math.round(screen) });
            add('INFO', where, 'video on screen against its decoded frame', `brightness ${Math.round(screen)} on screen, ${Math.round(decoded)} decoded, ${short(v.src)}`);
            if (Math.abs(screen - decoded) > 25) {
              fs.writeFileSync(path.join(OUT, `${slug(p)}-video-${n}-decoded.png`), Buffer.from(fr.split(',')[1], 'base64'));
              fs.writeFileSync(path.join(OUT, `${slug(p)}-video-${n}-screen.png`), buf);
              add('WARN', where, 'video on screen does not match its decoded frame (a WebGL texture, filter or overlay changes it; compare the two PNGs)', `screen brightness ${Math.round(screen)} against ${Math.round(decoded)} decoded, ${short(v.src)}`);
            }
          }
        }
      }
    }
    m.video.push(row);
  }
  await ctx.close();
}

async function efficiency(browser, p) {
  const where = `${p} efficiency`, gw = `${p} 3d`;
  const m = { path: p };
  // pass 1: desktop 1440, cache off, coverage on, WebGL counted
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(glHook);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Performance.enable');
    const req = new Map();
    cdp.on('Network.responseReceived', (e) => { const h = e.response.headers || {}; const enc = Object.keys(h).find((k) => k.toLowerCase() === 'content-encoding'); req.set(e.requestId, { url: e.response.url, type: (e.type || 'Other').toLowerCase(), mime: e.response.mimeType || '', enc: enc ? h[enc] : '', bytes: 0 }); });
    cdp.on('Network.loadingFinished', (e) => { const r = req.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    const cost = await page.evaluate(pageCost);

    // transfer
    const all = [...req.values()].filter((r) => r.bytes > 0);
    const bytesOf = (u) => all.filter((r) => r.url === u).reduce((n, r) => n + r.bytes, 0);
    const total = all.reduce((n, r) => n + r.bytes, 0);
    const byType = {};
    for (const r of all) byType[r.type] = (byType[r.type] || 0) + r.bytes;
    const origin = new URL(BASE).origin;
    const third = all.filter((r) => !r.url.startsWith(origin)).reduce((n, r) => n + r.bytes, 0);
    m.transfer = { total, requests: all.length, thirdParty: third, byType };
    add('INFO', where, 'transfer', `${kb(total)} KB in ${all.length} requests (${kb(third)} KB from other hosts): ` + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, b]) => `${t} ${kb(b)} KB`).join(', '));
    add('INFO', where, 'largest files', [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((r) => `${kb(r.bytes)} KB ${short(r.url)}`).join(' | '));
    if (total > 6 * 1048576) add('FAIL', where, 'page weight over 6 MB', `${kb(total)} KB`);
    else if (total > 2 * 1048576) add('WARN', where, 'page weight over 2 MB', `${kb(total)} KB`);
    const raw = all.filter((r) => /text|javascript|json|xml|svg/.test(r.mime) && r.bytes > 10240 && !r.enc);
    if (raw.length) add('WARN', where, 'text files sent without compression', `${kb(raw.reduce((n, r) => n + r.bytes, 0))} KB: ` + raw.slice(0, 6).map((r) => `${kb(r.bytes)} KB ${short(r.url)}`).join(', '));
    for (const r of all.filter((x) => x.type === 'image')) {
      if (/png|jpe?g|gif|bmp/.test(r.mime) && r.bytes > 51200) add('WARN', where, 'image not in WebP or AVIF', `${kb(r.bytes)} KB ${r.mime} ${short(r.url)}`);
      if (r.bytes > 512000) add('WARN', where, 'image over 500 KB', `${kb(r.bytes)} KB ${short(r.url)}`);
    }

    // what the page makes the browser wait for, and how images are placed
    m.renderBlocking = { scripts: cost.blockingJs.length, styles: cost.blockingCss.length };
    for (const u of cost.blockingJs) add('WARN', where, 'render-blocking script in <head> (no defer or async)', `${kb(bytesOf(u))} KB ${short(u)}`);
    const cssBytes = cost.blockingCss.reduce((n, u) => n + bytesOf(u), 0);
    for (const u of cost.blockingCss) if (!u.startsWith(origin)) add('WARN', where, 'render-blocking stylesheet from another host', `${kb(bytesOf(u))} KB ${short(u)}`);
    if (cssBytes > 51200) add('WARN', where, 'render-blocking CSS over 50 KB', `${kb(cssBytes)} KB in ${cost.blockingCss.length} file(s)`);
    for (const i of cost.imgs) {
      if (i.shown && !i.sized) add('WARN', where, 'image without width and height (moves the page as it loads)', short(i.src));
      if (i.below && !i.lazy && bytesOf(i.src) > 30720) add('WARN', where, 'image far below the fold not lazy-loaded', `${kb(bytesOf(i.src))} KB ${short(i.src)}`);
    }
    m.domNodes = cost.nodes;
    if (cost.nodes > 1500) add('WARN', where, 'DOM over 1500 elements', String(cost.nodes));

    // WebGL: per-frame cost since load, then idle and scrolled-away behaviour
    const gl = await page.evaluate(glRead);
    const canvas = await page.evaluate(() => { let best = null, area = 0; for (const c of document.querySelectorAll('canvas')) { const r = c.getBoundingClientRect(); if (r.width * r.height > area) { area = r.width * r.height; best = c; } } if (!best || area < 10000) return false; best.setAttribute('data-audit-canvas', ''); best.scrollIntoView({ block: 'center' }); return true; });
    // a scroll is input: scenes that render on demand ease for a moment after
    // one, so idle is counted once that has settled
    await page.waitForTimeout(3000);
    const c0 = await page.evaluate(() => ({ d: window.__gl.draws, f: window.__gl.frameCount }));
    const task0 = await taskSeconds(cdp);
    await page.waitForTimeout(2000);
    const task1 = await taskSeconds(cdp);
    const c1 = await page.evaluate(() => ({ d: window.__gl.draws, f: window.__gl.frameCount }));
    const busy = (task1 - task0) / 2;
    m.idleMainThread = +busy.toFixed(3);
    add('INFO', where, 'main thread while idle', `${Math.round(busy * 100)}% busy over 2 s with no input`);
    if (busy > 0.1) add('WARN', where, 'main thread over 10% busy while idle (battery, heat, slower scrolling)', `${Math.round(busy * 100)}%`);
    if (gl && gl.contexts) {
      let unchanged = null;
      if (canvas) {
        const a = await page.locator('[data-audit-canvas]').screenshot().catch(() => null);
        await page.waitForTimeout(700);
        const b = await page.locator('[data-audit-canvas]').screenshot().catch(() => null);
        if (a && b) unchanged = a.equals(b);
      }
      let away = null;
      if (canvas) {
        const gone = await page.evaluate(() => { const c = document.querySelector('[data-audit-canvas]'); const r = c.getBoundingClientRect(); const top = r.top + scrollY, bottom = r.bottom + scrollY; if (top > innerHeight) scrollTo(0, 0); else scrollTo(0, bottom + 10); const q = c.getBoundingClientRect(); return q.bottom < 0 || q.top > innerHeight; });
        if (gone) { await page.waitForTimeout(2500); const own = () => document.querySelector('[data-audit-canvas]').__auditDraws || 0; const d0 = await page.evaluate(own); await page.waitForTimeout(1500); away = (await page.evaluate(own)) - d0; }
      }
      const tex = gl.textures, maxTex = tex.reduce((n, t) => Math.max(n, t.w, t.h), 0);
      const texMB = tex.reduce((n, t) => n + t.w * t.h * (t.kind === 'compressed' ? 1 : 4) * (t.levels > 1 ? 4 / 3 : 1), 0) / 1048576;
      const idle = { draws: c1.d - c0.d, frames: c1.f - c0.f };
      m.webgl = { contexts: gl.contexts, three: gl.three, frames: gl.frames, drawsPerFrame: { median: gl.drawsMedian, p95: gl.drawsP95, max: gl.drawsMax }, trianglesPerFrame: { median: gl.trisMedian, max: gl.trisMax }, textures: tex.length, maxTexture: maxTex, textureMB: Math.round(texMB), idleDrawsPerSecond: idle.draws / 2, idleFps: idle.frames / 2, idleUnchanged: unchanged, drawsWhileAway: away };
      add('INFO', gw, 'webgl', `${gl.contexts} context(s)${gl.three ? ', three.js r' + gl.three : ''}; draw calls per frame median ${gl.drawsMedian}, p95 ${gl.drawsP95}, max ${gl.drawsMax}; triangles per frame median ${gl.trisMedian}; ${tex.length} texture upload(s), largest ${maxTex}px, about ${Math.round(texMB)} MB; idle ${idle.frames / 2} fps, ${idle.draws / 2} draws/s`);
      if (gl.drawsMedian > 1000) add('FAIL', gw, 'over 1000 draw calls per frame (merge or instance meshes)', String(gl.drawsMedian));
      else if (gl.drawsMedian > 150) add('WARN', gw, 'over 150 draw calls per frame (merge or instance meshes)', String(gl.drawsMedian));
      if (gl.trisMedian > 1000000) add('WARN', gw, 'over 1 million triangles per frame', String(gl.trisMedian));
      if (maxTex > 4096) add('FAIL', gw, 'texture over 4096 px (fails or is cut down on many phones)', `${maxTex}px`);
      else if (maxTex > 2048) add('WARN', gw, 'texture over 2048 px (more memory and upload time than any slot needs)', `${maxTex}px`);
      if (texMB > 64) add('WARN', gw, 'textures over 64 MB of GPU memory', `about ${Math.round(texMB)} MB`);
      if (gl.contexts > 4) add('WARN', gw, 'more than 4 WebGL contexts (browsers drop the oldest past 16)', String(gl.contexts));
      if (idle.frames >= 2 && unchanged === true) add('WARN', gw, 'redraws an unchanged picture while idle (render on change instead)', `${idle.frames / 2} fps, ${idle.draws / 2} draw calls/s, canvas pixels identical`);
      else if (idle.frames >= 2) add('WARN', gw, 'keeps rendering while idle', `${idle.frames / 2} fps, ${idle.draws / 2} draw calls/s${unchanged === false ? ', picture is moving' : ''}`);
      if (away > 0) add('WARN', gw, 'keeps drawing while scrolled out of view', `largest canvas: ${Math.round(away / 1.5)} draw calls/s`);
    }

    // unused code
    const jsCov = await page.coverage.stopJSCoverage();
    const cssCov = await page.coverage.stopCSSCoverage();
    const tally = (list, fn) => { const files = {}; for (const e of list) { if (!e.url) continue; const [len, used] = fn(e); const f = (files[e.url] ||= { len: 0, used: 0 }); f.len += len; f.used += used; } const t = Object.values(files).reduce((a, f) => ({ len: a.len + f.len, used: a.used + f.used }), { len: 0, used: 0 }); return { ...t, files }; };
    for (const [kind, list, fn, floor] of [['JS', jsCov, jsUsed, 51200], ['CSS', cssCov, cssUsed, 20480]]) {
      const t = tally(list, fn);
      const unused = t.len - t.used, share = t.len ? unused / t.len : 0;
      m['unused' + kind] = { bytes: t.len, unused, share: +share.toFixed(3) };
      const worst = Object.entries(t.files).map(([u, f]) => [u, f.len - f.used, f.len]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u, x, l]) => `${short(u)} ${kb(x)} of ${kb(l)} KB`).join(', ');
      add('INFO', where, `unused ${kind}`, `${Math.round(share * 100)}% of ${kb(t.len)} KB never ran${kind === 'CSS' ? ' or matched' : ''} after load and 8 s idle: ${worst}`);
      if (share > 0.5 && unused > floor) add('WARN', where, `over half the ${kind} is unused`, `${kb(unused)} KB unused: ${worst}`);
    }
    await ctx.close();
  }

  // pass 2: a mid-range phone, CPU slowed 4x: first paint, largest paint, blocking time
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3.5 });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__lt = []; window.__fcp = 0; window.__lcp = 0;
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { /* older engines lack some entry types */ }
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(BASE + p, { waitUntil: 'load', timeout: 120000 });
    const left = 10000 - (await page.evaluate(() => performance.now()));
    if (left > 0) await page.waitForTimeout(left);
    const t = await page.evaluate(() => ({ lt: window.__lt, fcp: window.__fcp, lcp: window.__lcp, canvases: [...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return r.width > 100 ? { ratio: +(c.width / r.width).toFixed(2), backing: `${c.width}x${c.height}` } : null; }).filter(Boolean) }));
    const after = t.lt.filter(([s]) => s >= t.fcp);
    const tbt = Math.round(after.reduce((n, [, d]) => n + Math.max(0, d - 50), 0));
    const longest = Math.round(t.lt.reduce((n, [, d]) => Math.max(n, d), 0));
    m.throttled = { fcp: Math.round(t.fcp), lcp: Math.round(t.lcp), tbt, longTasks: t.lt.length, longest };
    add('INFO', where, 'phone, 4x slower CPU', `first paint ${Math.round(t.fcp)} ms, largest paint ${Math.round(t.lcp)} ms, total blocking time ${tbt} ms in the first 10 s, ${t.lt.length} long tasks, longest ${longest} ms`);
    if (tbt > 2000) add('FAIL', where, 'total blocking time over 2000 ms (4x CPU)', `${tbt} ms`);
    else if (tbt > 600) add('WARN', where, 'total blocking time over 600 ms (4x CPU)', `${tbt} ms`);
    for (const c of t.canvases) if (c.ratio > 2.05) add('WARN', `${p} 3d`, 'canvas drawn above 2x on a 3.5x phone (fill cost with no visible gain)', `${c.ratio}x, ${c.backing}`);
    await ctx.close();
  }

  // pass 3: every video's file and what reaches the screen
  await videoPass(browser, p, m);
  metrics.push(m);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // an installed browser first (nothing to download), then Playwright's own
  // Chromium; --browser picks one. WebGL needs the GPU switched on headless.
  const gpu = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])];
  const pick = val('--browser', '');
  let browser = null;
  for (const channel of pick ? [pick] : ['msedge', 'chrome', 'chromium']) {
    try { browser = await chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), args: gpu }); break; } catch (e) { if (pick) throw e; }
  }
  if (!browser) { console.error('No browser found: install Edge or Chrome, or run `npx playwright install chromium`.'); process.exit(2); }

  // ---- once per site: meta, links, robots, sitemap ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const p of PATHS) {
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      const m = await page.evaluate(() => ({
        title: document.title, desc: document.querySelector('meta[name="description"]')?.content || '',
        viewport: !!document.querySelector('meta[name="viewport"]'), vpc: document.querySelector('meta[name="viewport"]')?.content || '', lang: document.documentElement.lang,
        canonical: document.querySelector('link[rel="canonical"]')?.href || '', og: document.querySelector('meta[property="og:image"]')?.content || '',
        icon: !!document.querySelector('link[rel~="icon"]'),
        links: [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)))],
      }));
      const where = `site ${p}`;
      if (!m.title || m.title.length < 10 || m.title.length > 65) add('WARN', where, 'title length', `${m.title.length}: ${m.title}`);
      if (!m.desc || m.desc.length < 50 || m.desc.length > 160) add('WARN', where, 'meta description length', `${m.desc.length}`);
      if (!m.viewport) add('FAIL', where, 'no viewport meta');
      else if (!/width\s*=\s*device-width/.test(m.vpc)) add('FAIL', where, 'viewport meta without width=device-width', m.vpc);
      // pinch zoom must stay available (WCAG 1.4.4)
      const maxScale = +(m.vpc.match(/maximum-scale\s*=\s*([\d.]+)/) || [])[1];
      if (/user-scalable\s*=\s*(no|0)/.test(m.vpc) || maxScale < 2) add('WARN', where, 'viewport meta blocks pinch zoom', m.vpc);
      if (!m.lang) add('FAIL', where, 'no html lang');
      if (!m.canonical) add('WARN', where, 'no canonical link');
      if (!m.og) add('WARN', where, 'no og:image');
      if (!m.icon) add('WARN', where, 'no favicon link');
      for (const href of m.links) {
        try {
          const r = await page.request.get(href, { timeout: 15000, maxRedirects: 5, failOnStatusCode: false });
          // social sites refuse automated visits; that is not a dead link
          const bots = /(^|\.)(x|twitter|linkedin|instagram|facebook|tiktok)\.com$/.test(new URL(href).hostname);
          if (r.status() >= 400) add(bots && [401, 403, 429, 999].includes(r.status()) ? 'WARN' : 'FAIL', where, bots ? 'social link refused an automated visit (check by hand)' : 'broken link', `${r.status()} ${href}`);
        } catch (e) { add('WARN', where, 'link did not answer', href); }
      }
    }
    for (const f of ['/robots.txt', '/sitemap.xml']) {
      const r = await page.request.get(BASE + f, { failOnStatusCode: false });
      if (r.status() >= 400) add('WARN', 'site', `${f} missing`, String(r.status()));
    }
    await ctx.close();
  }

  // ---- every page at every width ----
  for (const p of PATHS) {
    for (const v of WIDTHS) {
      const where = `${p} ${v.name}`;
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: v.dpr });
      const page = await ctx.newPage();
      const errors = [], failed = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      page.on('response', (r) => { if (r.status() >= 400 && !/\/_vercel\//.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
      page.on('requestfailed', (r) => { if (!/\/_vercel\/|favicon/.test(r.url()) && r.failure()?.errorText !== 'net::ERR_ABORTED') failed.push(`failed ${r.url()} ${r.failure()?.errorText}`); });
      await page.addInitScript((ig) => { window.__auditIgnore = ig; }, IGNORE.map((x) => x.selector));
      await page.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {} });
      await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(6000);
      // scroll through so lazy content loads, then back to the top
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); } scrollTo(0, 0); });
      await page.waitForTimeout(1200);
      await page.evaluate(() => Promise.all([...document.images].filter((i) => i.complete && i.currentSrc).map((i) => new Promise((res) => { const x = new Image(); x.onload = x.onerror = () => { if (x.naturalWidth) i.dataset.auditPx = x.naturalWidth; res(); }; x.src = i.currentSrc; }))));
      const r = await page.evaluate(probe);
      const cls = await page.evaluate(() => window.__cls);
      for (const e of errors) add('FAIL', where, 'page error', e);
      for (const f of failed) add('FAIL', where, 'failed request', f);
      if (r.overflowX > 1) add('FAIL', where, 'page scrolls sideways', `${r.overflowX}px`);
      for (const i of r.images) add(i.kind === 'upscaled' ? 'FAIL' : 'WARN', where, i.kind === 'upscaled' ? 'image shown larger than its pixels (blurry)' : 'image far larger than shown (wasted bytes)', JSON.stringify(i));
      for (const c of r.canvases) add('FAIL', where, 'canvas drawn below screen density (soft, jagged edges)', JSON.stringify(c));
      for (const c of r.clipped.slice(0, 15)) add('FAIL', where, 'text clipped', JSON.stringify(c));
      for (const o of r.overlaps.slice(0, 15)) add('FAIL', where, 'text overlaps text', JSON.stringify(o));
      if (v.mobile) for (const t of r.smallTargets.slice(0, 15)) add('WARN', where, 'tap target under 24px', JSON.stringify(t));
      for (const t of r.smallText.slice(0, 10)) add('WARN', where, 'text under 11px', JSON.stringify(t));
      for (const a of r.noAlt) add('FAIL', where, 'image without alt', a);
      for (const e of r.pointerNoRole.slice(0, 10)) add('WARN', where, 'looks clickable but is not a control', e);
      if (r.h1 !== 1) add('WARN', where, 'h1 count', String(r.h1));
      for (let i = 1; i < r.headings.length; i++) if (r.headings[i] > r.headings[i - 1] + 1) { add('WARN', where, 'heading level skipped', `h${r.headings[i - 1]} to h${r.headings[i]}`); break; }
      if (cls > 0.1) add('FAIL', where, 'layout shift (CLS) over 0.1', cls.toFixed(3));
      if (AXE) {
        // evaluated, not added as a <script>: a strict CSP would block the tag
        await page.evaluate(AXE_SRC);
        const ax = await page.evaluate(async () => (await window.axe.run(document)).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id} x${x.nodes.length}: ${x.help} :: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
        for (const a of ax) add('FAIL', where, 'accessibility', a);
      }
      await page.screenshot({ path: path.join(OUT, `${p.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'home'}-${v.name}.png`), fullPage: true }).catch(() => {});

      // every button once: a control that changes nothing on screen is a bug.
      // Links to "#" or javascript: count as buttons; jumping to the top is not their job.
      if (CLICK && (v.name === 'phone-412' || v.name === 'desktop-1440')) {
        const n = await page.evaluate(() => { const els = [...document.querySelectorAll('button, [role="button"], a[href="#"], a[href^="javascript:"]')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && !e.disabled && !e.form && !e.closest('form'); }); els.forEach((e, i) => e.setAttribute('data-audit-btn', i)); return els.length; });
        for (let i = 0; i < Math.min(n, 80); i++) {
          const sel = `[data-audit-btn="${i}"]`;
          const before = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; window.__mut = 0; window.__mo?.disconnect(); window.__mo = new MutationObserver((l) => { window.__mut += l.length; }); window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); e.scrollIntoView({ block: 'center' }); return { url: location.href, y: scrollY, link: e.tagName === 'A', name: (e.getAttribute('aria-label') || e.textContent.trim() || e.title || (e.querySelector('[class]') || e).className.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 60) }; }, sel);
          if (!before) continue;
          const pages = ctx.pages().length;
          try { await page.locator(sel).first().click({ force: true, timeout: 3000 }); } catch { continue; }
          await page.waitForTimeout(450);
          const after = await page.evaluate(() => ({ url: location.href, y: scrollY, mut: window.__mut }));
          const popped = ctx.pages().length > pages;
          const same = (u) => u.replace(/#$/, '');
          if (!popped && after.mut === 0 && same(after.url) === same(before.url) && (before.link || Math.abs(after.y - before.y) < 2)) add('WARN', where, before.link ? 'link to "#" did nothing when pressed' : 'button changed nothing when pressed', before.name || sel);
          for (const extra of ctx.pages().slice(pages)) await extra.close().catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          if (same(page.url()) !== same(before.url)) await page.goto(BASE + p, { waitUntil: 'networkidle' }).catch(() => {});
        }
      }
      await ctx.close();
    }
  }
  if (EFFICIENCY) for (const p of PATHS) await efficiency(browser, p).catch((e) => add('WARN', `${p} efficiency`, 'efficiency pass did not finish', String(e).slice(0, 200)));
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(findings, null, 1));
  if (EFFICIENCY) fs.writeFileSync(path.join(OUT, 'efficiency.json'), JSON.stringify(metrics, null, 1));
  const fails = findings.filter((f) => f.level === 'FAIL').length, warns = findings.filter((f) => f.level === 'WARN').length;
  console.log(`\n${fails} FAIL, ${warns} WARN. Report and screenshots: ${OUT}`);
  process.exit(fails ? 1 : 0);
})();
