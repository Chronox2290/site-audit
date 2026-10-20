---
name: site-audit
description: Full automated quality audit of a website before and after every deploy - errors, broken requests and links, sideways scroll, blurry or oversized images, low-density canvases (jagged 3D), clipped and overlapping text, tap targets, small text, alt text, headings, layout shift, axe accessibility, meta tags and pinch zoom, every button and "#" link pressed once to catch controls that do nothing, plus measured efficiency (page weight, compression, unused JS and CSS, render-blocking head files, blocking time on a slowed phone, idle CPU) and 3D cost (draw calls and triangles per frame, texture sizes and memory, rendering while idle or scrolled away). Use on every site change before it ships and on the live URL after, instead of spot-checking by eye.
---

# Site audit

Run it on every change, before shipping (local build) and after (live URL).

```bash
node ~/.claude/skills/site-audit/audit.cjs <base-url> <out-dir> [--paths /,/about] [--no-click] [--no-efficiency] [--ignore file] [--browser msedge|chrome|chromium]
```

- Widths: phone 360 (3x) and 412 (3.5x), tablet 820 (2x), desktop 1440, 1920 and 2560 (1.5x).
- Exit code 1 on any FAIL. `<out-dir>/report.json` holds every finding (FAIL, WARN, and INFO lines carrying the measured numbers); `<out-dir>/efficiency.json` holds the efficiency and 3D numbers per page; full-page screenshots per width sit beside them (`home-<width>.png` for `/`).
- `--no-efficiency` skips the efficiency pass (about 30 s per page). `--no-click` skips the button pass.
- A project can list known, separately tested exceptions in `.site-audit-ignore.json` at its root: `[{"selector": "...", "reason": "how it was checked instead"}]`. Every entry needs a reason naming the test that covers it; the run prints them all.
- Needs Node 18 or later and `npm install` in the skill folder once (playwright-core and axe-core). It uses an installed Edge or Chrome, so nothing large is downloaded; with neither, run `npx playwright install chromium`. `--browser` picks one.

## Efficiency and 3D: what is measured, and the thresholds

Once per page, after the width checks. Pass 1 loads the page at 1440 px with the cache off, coverage on and every WebGL context wrapped (works for three.js, Babylon, raw WebGL, anything). Pass 2 loads it on a 412 px 3.5x phone with the CPU slowed 4x.

| Check | WARN | FAIL |
|---|---|---|
| Page weight, first load before scrolling | over 2 MB | over 6 MB |
| Text file (HTML, JS, CSS, JSON, SVG) over 10 KB sent without gzip or brotli | any | |
| Image in PNG, JPEG or GIF over 50 KB (use WebP or AVIF) | any | |
| Single image over 500 KB | any | |
| Script in `<head>` without `defer`, `async` or `type=module` (nomodule ignored) | each | |
| Render-blocking stylesheet from another host | each | |
| Render-blocking CSS in total | over 50 KB | |
| `<img>` with no width/height or aspect-ratio | each | |
| Image more than 1.5 screens down, over 30 KB, not `loading=lazy` | each | |
| DOM elements | over 1500 | |
| Unused JS (V8 block coverage, after load and 8 s idle) | over 50% and over 50 KB | |
| Unused CSS (rules never matched) | over 50% and over 20 KB | |
| Main thread busy with no input, over 2 s | over 10% | |
| Total blocking time, first paint to 10 s, phone, 4x CPU | over 600 ms | over 2000 ms |
| WebGL draw calls per frame (median) | over 150 | over 1000 |
| Triangles per frame (median) | over 1 million | |
| Largest texture upload | over 2048 px | over 4096 px |
| Texture memory estimate (w x h x 4, x4/3 with mipmaps) | over 64 MB | |
| WebGL contexts on one page | over 4 | |
| Draws while idle and the picture is unchanged (two canvas screenshots identical) | "redraws an unchanged picture" | |
| Draws while idle and the picture moves | "keeps rendering while idle" | |
| Largest canvas keeps drawing after it is scrolled off screen (counted for that canvas only) | any | |
| Canvas backing store above 2x its CSS size on the 3.5x phone | each | |

Always printed as INFO: transfer by type and the five largest files, unused JS and CSS by file, first paint, largest paint and long tasks at 4x CPU, the idle main thread share, and per-frame draw calls (median, p95, max), triangles, texture count, size and memory, and the three.js revision.

How to read them:
- Draw calls: each separate mesh and material is a call. Hundreds of copies of one shape belong in an `InstancedMesh` (one call) or a merged geometry.
- Idle drawing: a scene that only changes on input or resize should render on demand (render once, then on change). A scene that animates on purpose still costs battery; pause it when the canvas is off screen (IntersectionObserver) and when the tab is hidden, and respect `prefers-reduced-motion`.
- Pixel ratio: render at `Math.min(devicePixelRatio, 2)`. Below that the low-density check FAILs (jagged); above it this pass WARNs (fill cost with no visible gain).
- Idle is counted 3 s after the canvas is scrolled into view, and scrolled-away drawing 2.5 s after it leaves, so a scene that eases for a moment after a scroll is not reported as drawing while idle.
- Idle "fps" is not a real frame rate: headless Edge does not lock frames to a screen, so it can read 150 or more. Read it as "draws continuously".
- Total blocking time on a live site varies between runs (800 to 3800 ms on one site in one evening). Run it two or three times before quoting it. The other numbers repeat exactly.
- Unused JS from a full library build (three.js is about 60% unused for a small scene) is expected without a bundler; say so rather than chasing it.

## The run, every time

1. Run the script. Fix every FAIL. Read every WARN and fix or write down why it stays.
2. **Look at every screenshot yourself**, at full size, every width. The script cannot judge taste: alignment, centring, balance, things that look broken but measure fine. Compare against the previous version where one exists.
3. For a 3D or canvas page, check the scene's framing in the screenshot (subject cut off, dead space), and if the page has a non-3D fallback, compare the two side by side.
4. For every control: does it look pressable, does pressing it do what its label says, does its light or state show it? The click pass flags buttons and `#` links that change nothing; read those names.
5. Report with context: what each remaining WARN means for visitors, Google or clients, with a source where a claim needs one.

## What it does not catch

Taste and brand fit, copy quality and whether claims are true, 3D composition, text that flows wrong without clipping (for example a flex row splitting a sentence into columns), sound, real-device GPU speed and network latency (use Lighthouse with `lighthouse-audit` and real-visitor data), WebGL in workers or OffscreenCanvas, bytes that load only after scrolling or clicking, and anything behind a login or a form submit (it never submits forms). Full-page phone screenshots repeat a sticky header at the bottom; that is the capture, not the page.

A worked before and after, a deliberately bad page and its rebuild, lives in `demo/` (see the README).
