---
name: perftale
description: Turn a Chrome DevTools performance trace into actionable runtime-performance insights for animation- and interaction-heavy web apps (pixi/canvas game loops, DOM/React/Motion UIs). Use when the user has a recorded performance trace (.json or .json.gz) and wants to find and fix jank, dropped frames, or a slow rAF/render loop — NOT for startup/load-time analysis. Trigger when the user shares a trace file, says "analyze this trace", "why is this janky", "find the dropped frames", "what's eating my frame budget", or asks you to investigate a flame chart.
---

# perftale — Chrome trace → actionable insights

perftale reduces a huge Chrome performance trace (hundreds of MB) into a compact,
structured summary you can read in one shot, then act on: it tells you whether the
app is smooth, where the per-frame budget goes, and which functions (with
`file:line`) to fix.

It is built for **runtime** performance of animation/interaction-heavy apps — 60fps
game loops, canvas/pixi rendering, DOM + React + Motion UIs. It is NOT about startup
or load time.

## Running it

```
node bin/perftale.ts analyze <trace.json[.gz]> [--fps <n>] [--json] [--debug]
```

- Accepts `.json` or gzipped `.json.gz`; streams it, so a 350MB trace is fine.
- `--json` writes the structured summary to `.perftale/<trace>.summary.json`
  (use `--out <path>` for a custom location). Read that file to investigate.
- `--fps <n>` overrides the refresh rate if detection looks wrong.
- `--debug` adds pipeline diagnostics (noise reduction, pipeline latency,
  dropped-frame clusters) — usually not needed.

If the user only has a screen recording or a live app, ask them to record a trace:
DevTools → Performance → Record → reload/interact → Stop → "Save profile…".

## How to read the output

**FRAMES** — the smoothness verdict.

- `refresh` — detected display rate; the per-frame budget is `1000/hz` ms (16.67ms at
  60Hz, 8.33ms at 120Hz).
- `warmup: first Nms excluded` — the CPU profiler stalls the main thread on startup,
  dropping every frame; that is a capture artifact and is excluded. Ignore jank in
  this window.
- `dropped: N frames — X%` — the headline. 0% dropped = smooth. The % is of _attempted_
  frames (idle vsyncs don't count against it).
- `worst freeze` — longest screen-frozen span that actually contained dropped frames
  (real jank), with a timestamp.
- `largest gap` — longest gap between presented frames _regardless of drops_. May be
  benign idle (app had nothing to draw) OR a main-thread block. Cross-check with the
  JS section / long tasks before treating it as jank.
- `main-thread frame time` — where the frame budget goes: `animation / rAF callbacks`,
  `style recalc`, `layout`, `paint`, `composite commit`, etc. This tells you the
  _domain_ of the problem (script vs layout vs paint vs compositing).

**JS (self-time by function)** — which code to fix.

- `active CPU … : Xms JS / Yms engine+native / Zms GC (idle …)` — of non-idle CPU,
  how much is attributable JS vs engine/native. A large `engine+native` bucket is
  usually console-instrumentation overhead from recording with DevTools attached — it
  is NOT app code; do not try to "fix" it.
- Each row: `selfMs  share%  [APP]  functionName  file:line`. `APP` marks first-party
  source (not a dependency). Open those `file:line`s first.

## Investigation workflow

1. **Run** `perftale analyze <trace> --json` and read the summary.
2. **Verdict.** If `dropped` ≈ 0%, the app is smooth — say so; the remaining signal is
   "how close to the edge" (how full the frame budget is). If there are drops/freezes,
   note when they happen.
3. **Find the domain** from `main-thread frame time`:
   - `animation / rAF callbacks` dominant → **JS/script-bound**. Go to the JS section.
   - `style recalc` / `layout` dominant → **layout-bound** (often forced reflow or huge
     style recalc; common with DOM/React).
   - `paint` / `composite commit` / `update layers` dominant → **rendering/compositing-
     bound** (too many/large layers, layout-animating Motion, large repaints). The JS
     section will be small here — don't chase JS.
4. **For JS-bound:** open the top `APP` functions at their `file:line`. Look for work
   done every frame that shouldn't be: per-frame allocation (GC pressure), recomputing
   something cacheable, re-triangulating/re-measuring unchanged geometry, walking the
   whole scene graph. Dependency rows (pixi, motion, earcut, react) tell you _which
   subsystem_ is hot even when you can't edit it — often you reduce calls into it.
5. **Map to source** in the repo (the trace gives bundled `file:line`; grep the
   function name to find the real source).
6. **Propose and apply a fix**, then **re-record a trace and re-run** to confirm the
   dropped-frame count / hot-function self-time actually improved.

## Fix playbooks

**Canvas / pixi game loop (rAF-bound):**

- Hoist allocations out of the per-frame loop; reuse objects/arrays/vectors (cuts GC).
- Cache geometry that doesn't change frame-to-frame (don't re-triangulate/re-measure).
- Avoid full scene-graph bounds/transform recompute every frame; dirty-flag what moved.
- Batch draws; avoid per-sprite state changes and mid-frame texture uploads.

**DOM / React / Motion (layout/paint/composite-bound):**

- Eliminate forced reflow (reading layout — `offsetWidth`, `getBoundingClientRect` —
  interleaved with writes inside a frame).
- Animate `transform`/`opacity`, not layout-affecting properties; prefer Motion's
  transform animations over layout animations when many nodes animate.
- Reduce the number of simultaneously animating DOM nodes / composited layers.
- Memoize selectors and component subtrees so rAF work and re-renders shrink.

## Caveats to keep in mind

- **Dev builds inflate the numbers.** `jsxDEV` / `react-dom_client` dev internals and a
  big engine+native bucket mean a development build with React DevTools active. For the
  cleanest profile, recommend recording a production build without extensions.
- **Extension-injected scripts** (e.g. `installHook.js` from React DevTools, a
  `page.bundle.js` from a Redux DevTools extension) can appear and may be mis-tagged
  `APP`. Treat unfamiliar `file:1`-style entries skeptically.
- **Pipeline latency ≠ frame interval.** A frame takes a few vsyncs to traverse the
  compositor pipeline even when perfectly smooth; that latency is not jank.
