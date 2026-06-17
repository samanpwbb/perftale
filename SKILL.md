---
name: perftale
description: Turn a Chrome DevTools performance trace into actionable runtime-performance insights for animation- and interaction-heavy web apps (pixi/canvas game loops, DOM/React/Motion UIs). Use when the user has a recorded performance trace (.json or .json.gz) and wants to find and fix jank, dropped frames, or a slow rAF/render loop — NOT for startup/load-time analysis. Trigger when the user shares a trace file, says "analyze this trace", "why is this janky", "find the dropped frames", "what's eating my frame budget", or asks you to investigate a flame chart.
---

# perftale — Chrome trace → actionable insights

perftale reduces a huge Chrome performance trace (hundreds of MB) into a compact,
structured summary: whether the app is smooth, where the per-frame budget goes, and
which functions (`file:line`) to fix. It targets **runtime** performance of
animation/interaction-heavy apps — 60fps game loops, canvas/pixi, DOM/React/Motion UIs
— **not** startup or load time.

## Running it

```
perftale analyze <trace.json[.gz]> [--fps <n>] [--json] [--debug]
```

(Not on PATH? Run from a clone: `node bin/perftale.ts analyze <trace> …`.)

- Streams `.json` or gzipped `.json.gz` — a 350MB trace is fine.
- `--json` writes the summary to `.perftale/<trace>.summary.json` (or `--out <path>`).
  Read that file to investigate.
- `--fps <n>` overrides refresh-rate detection; `--debug` adds pipeline diagnostics
  (rarely needed).

No trace yet? Have the user record one: DevTools → Performance → Record →
reload/interact → Stop → "Save profile…".

## Reading the output

Inverted pyramid — conclusion first, then the numbers behind it.

**VERDICT** — read first.

- `headline` — the one-line conclusion: refresh rate, dropped frames, and the worst
  freeze + its blocking task. Smooth or janky is told by the numbers (and `smooth`).
- `bound` — the dominant main-thread domain (`animation` / `layout` / `paint/composite`)
  and its share. **This is where to look.**
- `hotspot` — top first-party (`APP`) function to open, with `file:line`.
- `note` — caveats that temper the numbers (dev build, extensions, instrumentation
  overhead). Heed before trusting magnitudes.

**FRAMES** — smoothness.

- `refresh` — display rate; frame budget = `1000/hz` ms (16.67ms@60Hz, 8.33ms@120Hz).
- `warmup: first Nms excluded` — the CPU profiler stalls the main thread on startup,
  dropping every frame. Capture artifact, not jank — ignore drops in this window.
- `dropped  N frames · X% of attempted` — the headline number. 0% = smooth. Percent is
  of _attempted_ frames (idle vsyncs don't count).
- `worst freeze` — longest frozen span that actually dropped frames (real jank),
  timestamped and annotated with its blocking task when one explains it.
- `largest gap` — longest gap between presented frames regardless of drops, annotated
  `idle — no long task` (benign) or `blocked by a Nms task` (real — go find that task).
- `main-thread frame time` — where the budget goes (rAF/animation, style recalc,
  layout, paint, composite). Tells you the _domain_: script vs layout vs paint vs compositing.

**LONG TASKS** — main-thread tasks over the threshold (default 50ms), longest first,
timestamped. Each blocks the frame loop for its whole duration. Match timestamps to the
freezes to see which jank each caused. Each task is attributed: a `trigger`
(`input event` / `timer` / `animation frame` / `script eval` …), a category split
(`scripting` / `layout` / `paint` / `gc`) from its nested timeline events, and the
`hottest` JS function sampled during it — the code to open and fix.

**REFLOW** — forced synchronous layout, a.k.a. layout thrashing (`null` unless some
layout was forced). Reading layout geometry (`offsetWidth`, `getBoundingClientRect`,
`getComputedStyle`) while the DOM is dirty makes the browser flush layout _inside_ your
script — time that hides in the `animation`/script bound, so the aggregate breakdown
can't see it.

- `N forced layouts + M style recalcs — Xms total` — `Layout`/`UpdateLayoutTree` events
  found nested inside a `FunctionCall` (forced), vs sitting under `RunTask` (scheduled,
  benign — not counted).
- `worst burst K in one call` — the read/write-in-a-loop signature; K reads forcing K
  flushes inside one function. `~R/frame` is the rate.
- `run-up culprits` — **a heuristic** (like GC allocators): the JS hottest in the run-up
  to each flush — the likely reader. The forcing geometry read itself is tiny, so this
  names the surrounding code to open, not a single line.
- **DevTools artifact:** if the top culprit is a `-extension://` script (e.g. React
  DevTools' `measureHostInstance`), the forced reflow is DevTools measuring components,
  not your app — it won't happen in production. The VERDICT note flags this; re-capture
  with DevTools detached to measure your app's own forced reflow.

**GC PRESSURE** — GC cost and likely cause (`null` if the trace has no V8 GC instrumentation).

- `N scavenges … + M mark-compact … — Zms pauses` — synchronous main-thread GC pauses
  from instrumented `MinorGC`/`MajorGC`. More precise than the sampled `GC` in the JS
  section, and carries bytes freed.
- `~NNNmb young garbage` — a high scavenge rate reclaiming lots of young garbage is the
  classic game-loop signature: per-frame allocation churn.
- `suspected allocators` — **a heuristic, not proof.** The JS hottest just before each
  scavenge; treat as leads, not the culprit. For ground truth, capture a sampling heap
  profile (DevTools → Memory → "Allocation sampling").

**REACT** — component renders, from React DevTools' own User Timing measures (`null`
unless recorded with DevTools attached, i.e. local dev). Authoritative, not a heuristic.

- `N renders across M components` — a render count far above the frame count means
  components re-render many times per frame.
- Each row `self  ×renders  component`: **high `×renders` is the usual smell** — an
  unmemoized component (bad state placement / unstable props) rendering every frame.
  `self` excludes nested children.
- DevTools recording inflates the ms — read **counts** as primary, ms as relative.

**JS** — self-time by function; the code to fix.

- `active CPU … : Xms JS / Yms engine+native / Zms GC` — a large `engine+native` bucket
  is usually console-instrumentation overhead from recording with DevTools attached.
  **Not app code — don't "fix" it.**
- Each row `self  share  [APP]  fn  location` (a dim header names the columns):
  `APP` = first-party source. Open those `file:line`s first.

## Investigation workflow

1. Run `perftale analyze <trace> --json` and read the summary.
2. **Smooth?** `dropped` ≈ 0% → say so; the remaining signal is how full the budget is.
   Drops/freezes → note when they happen.
3. **Find the domain** from `main-thread frame time`:
   - `animation / rAF` → **JS-bound** → JS section.
   - `style recalc` / `layout` → **layout-bound** (forced reflow, big recalc; common with
     DOM/React). Check the **REFLOW** section — forced synchronous layout is charged to
     script, so a "forced reflow" finding can explain an `animation`-looking bound.
   - `paint` / `composite` → **rendering-bound** (too many/large layers, layout-animating
     Motion, big repaints). JS will be small — don't chase it.
4. **JS-bound:** open the top `APP` functions. Look for per-frame work that shouldn't
   repeat: allocation (GC), recomputing cacheable values, re-triangulating unchanged
   geometry, walking the whole scene graph. Dependency rows (pixi/motion/earcut) show
   which _subsystem_ is hot even when you can't edit it — reduce calls into it.
   Cross-reference GC suspected-allocators against these hot functions.
5. **React UIs:** check `×renders` first — a component rendering many times per frame is
   almost always it (memoize, move state down, stabilize props). Then `selfMs` for
   expensive individual renders. Heavy React trees usually show up as `style recalc` /
   `layout` too.
6. **Map to source:** the trace gives bundled `file:line`; grep the function name for the real source.
7. **Fix, then re-record and re-run** to confirm dropped frames / hot self-time actually improved.

## Fix playbooks

**Canvas / pixi (rAF-bound):**

- Hoist allocations out of the per-frame loop; reuse objects/arrays/vectors.
- Cache geometry that doesn't change frame-to-frame.
- Dirty-flag what moved instead of recomputing all bounds/transforms each frame.
- Batch draws; avoid per-sprite state changes and mid-frame texture uploads.

**DOM / React / Motion (layout/paint/composite-bound):**

- Eliminate forced reflow (layout reads — `offsetWidth`, `getBoundingClientRect` —
  interleaved with writes inside a frame). When the **REFLOW** section names a run-up
  culprit, open it and batch all DOM reads before any writes (read everything first, then
  mutate) so layout flushes once per frame instead of inside the loop.
- Animate `transform`/`opacity`, not layout properties; prefer Motion transforms over
  layout animations when many nodes move.
- Reduce simultaneously animating nodes / composited layers.
- Memoize selectors and subtrees to shrink rAF work and re-renders.

## Caveats

- **Dev builds inflate numbers.** `jsxDEV` / `react-dom` dev internals + a big
  engine+native bucket = a dev build with DevTools active. For clean magnitudes,
  recommend a production build without extensions.
- **Extension scripts** (`installHook.js`, a `page.bundle.js`) can appear and be
  mis-tagged `APP`. Treat unfamiliar `file:1` entries skeptically.
- **Pipeline latency ≠ frame interval.** A frame takes a few vsyncs through the
  compositor even when smooth; that's not jank.
