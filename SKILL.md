---
name: perftale
description: Turn a Chrome DevTools performance trace into actionable runtime-performance insights for animation- and interaction-heavy web apps. Use when the user has a recorded performance trace (.json or .json.gz) and wants to find and fix jank, dropped frames, or a slow rAF/render loop — NOT for startup/load-time analysis. Trigger when the user shares a trace file, says "analyze this trace", "why is this janky", "find the dropped frames", "what's eating my frame budget", or asks you to investigate a flame chart.
---

# perftale — Chrome trace → actionable insights

perftale reduces a huge Chrome performance trace (hundreds of MB) into a compact,
structured summary: whether the app is smooth, where the per-frame budget goes, and
which files and functions (`file:line`) to fix. It targets **runtime** performance of
animation/interaction-heavy apps — 60fps game loops, canvas/pixi, DOM/React/Motion UIs
— **not** startup or load time.

## Running it

```
perftale <trace.json[.gz]> [--fps <n>] [--json] [--debug]
```

(Not on PATH? Run from a clone: `pnpm analyze <trace> …` or `node bin/perftale.ts <trace> …`.)

- Streams `.json` or gzipped `.json.gz` — a 350MB trace is fine.
- `--json` writes the summary to `.perftale/<trace>.summary.json` (or `--out <path>`).
  Read that file to investigate.
- `--fps <n>` overrides refresh-rate detection; `--debug` adds pipeline diagnostics
  (rarely needed).

No trace yet? Have the user record one: DevTools → Performance → Record →
reload/interact → Stop → "Save profile…". To investigate a **memory leak**, tick the
**Memory** checkbox before recording and capture ~20–30s on the suspect screen (idle is
ideal) so the heap-floor trend is unambiguous — without it the MEMORY section is `null`.

## Reading the output

Inverted pyramid — conclusion first, then the numbers behind it.

**VERDICT** — read first.

- `headline` — the one-line conclusion: refresh rate, dropped frames, and the worst
  freeze + its blocking task. Smooth or janky is told by the numbers (and `smooth`).
- `bound` — the dominant main-thread domain (`animation` / `layout` / `paint/composite`)
  and its share. **This is where to look.**
- `hotspot` — top first-party (`APP`) function to open, with `file:line`.
- `hot file` — top first-party **file** by self-time. Shown **only when it disagrees
  with `hotspot`**, because that disagreement is the signal: the function ranking
  can't see cost that lives in anonymous callbacks (see **JS** / **FILES** below), the
  file ranking can. When it appears, start there.
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

**FRAME DROPS** — the time-axis join, anchored on each freeze (`null` when nothing
dropped). This does the cross-referencing for you: per freeze it names the **cause** and
shows what coincided — the **blocked by** long task, **cpu in freeze** (JS/native/GC self-
time charged to exactly that span), the **hottest** function during it, and explicit **gc**
/ **reflow** rows (`none in window` / `no GC instrumentation` so absence is stated, not
implied). Read the **cause** first; the rest is the evidence.

- `coincidence across the trace` — the "is X my problem" table. Each of `long tasks` / `gc`
  / `reflow` is `N total · M near a drop → verdict`. **`implicated`** = it landed on a drop;
  **`cleared`** = it happened but never coincided with one (e.g. _"GC fired 40× but 0 near a
  drop"_ — not your jank source, stop chasing it); **`n/a`** = no such events; **`capture
artifact`** = forced reflow driven by a DevTools extension, ignore it.
- Causes: `long-task` (a task blocked the main thread), `gc`, `forced-reflow`, `script` (JS
  filled the freeze), `unknown` (no main-thread cause stood out — likely paint/composite or
  GPU/off-main-thread). Use it to decide which detail section below to open.

**LONG TASKS** — main-thread tasks over the threshold (default 50ms), longest first,
timestamped. Each blocks the frame loop for its whole duration. The FRAME DROPS section
already matches these to the freezes; this lists them in full. Each task is attributed: a
`trigger`
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

**MEMORY** — retained-memory growth over the recording, from the DevTools Memory
counters (`null` unless recorded with the **Memory** checkbox on). This is the
leak detector: a CPU profile shows where time _goes_, this shows what is _retained_.

- The verdict line is `leak likely` / `possible growth` / `no sustained growth`. The
  signal is a **rising post-GC heap floor** (the lower envelope, with the
  allocate-then-collect sawtooth stripped) — the live set the collector can't reclaim
  climbing even as GC runs. A flat floor under a tall sawtooth is just churn, not a leak.
- **`leak likely` vs `possible growth` turns on activity** (`N% idle`): memory climbing
  while the app sits **idle** is the strong signal (it shouldn't grow when nothing is
  happening); climbing **under load** may be a working set filling up, so it's hedged —
  record ~30s on an idle/stable screen to be sure.
- Per-counter rows: `heap` (floor rate + sawtooth range), `listeners`, `nodes`,
  `documents`. **A monotonic, never-released `listeners` climb is the classic leak** —
  an `addEventListener`/`.on()`/`subscribe`/`setInterval`/observer added without its
  paired removal. Rising `nodes` = detached DOM retained; rising `documents` = detached
  iframes retained. `heap` growing while these are flat = retained JS objects.
- `suspected sources` — **a heuristic** (like GC allocators): the JS hottest while memory
  grew. A lead on _where_, not proof — the registering code can be cold. Confirm by
  diffing two DevTools heap snapshots to see which retained objects grew.

**REACT** — component renders, from React DevTools' own User Timing measures (`null`
unless recorded with DevTools attached, i.e. local dev). Authoritative, not a heuristic.

- `N renders across M components` — a render count far above the frame count means
  components re-render many times per frame.
- Each row `self  ×renders  component`: **high `×renders` is the usual smell** — an
  unmemoized component (bad state placement / unstable props) rendering every frame.
  `self` excludes nested children.
- DevTools recording inflates the ms — read **counts** as primary, ms as relative.

**JS** — self-time by function; the line to fix.

- `active CPU … : Xms JS / Yms engine+native / Zms GC` — a large `engine+native` bucket
  is usually console-instrumentation overhead from recording with DevTools attached.
  **Not app code — don't "fix" it.**
- Each row `self  share  [APP]  fn  location` (a dim header names the columns):
  `APP` = first-party source. Open those `file:line`s first.
- **This table has a known blind spot.** Work done in a callback or closure has no
  function name, so it's reported as `(anonymous)` — one row per call site. An
  expensive scheduler/emitter/subscription callback therefore splinters into many
  small rows and ranks below cheaper named functions. When anonymous rows hold ≥15%
  of JS self-time the section says so under the table, and `verdict.anonBlindspot`
  carries the same conclusion (with a note in `verdict.notes`) in the JSON. Heed it:
  the top of this table can be genuinely misleading in callback-heavy code
  (schedulers, event emitters, store fan-out, React internals).

**FILES** — the _same_ self-time rolled up by source file; which subsystem is expensive.
Answers a different question from **JS**: file-level says which subsystem, function-level
says which line. Use both.

- The headline `Xms app code (N%) · Yms dependencies (M%) · K files` is the framing
  number: **if most JS is inside dependencies, the fix is to give the engine less to
  do — fewer sprites, fewer nodes, fewer reactive updates — not to micro-optimize your
  own functions.**
- Two rankings, deliberately separate: `app code` and `dependencies` (engine/library
  code). Each is ranked independently so an engine that dominates the trace can't crowd
  the app files out of view.
- **The split is by source path**, the same test behind the `APP` tag: a url is a
  dependency if it looks like `node_modules` / `.vite` / `deps` / an extension. On a
  dev server that is accurate. On a **fully bundled production build every file is one
  or two chunks**, so everything lands in `app code` and the split degenerates — read
  the per-file rows, not the headline, when the file list is a handful of hashed
  bundle names.
- The `spread` column says how a file's cost is distributed: `4 fns`, and `· N% anon`
  when at least half of it is anonymous. **`1 fn · 100% anon` means one callback holds
  the entire file's cost and the JS table filed it under `(anonymous)`** — that file is
  invisible above and is often the thing to fix.

## Investigation workflow

1. Run `perftale <trace> --json` and read the summary.
2. **Smooth?** `dropped` ≈ 0% → say so; the remaining signal is how full the budget is.
   Drops/freezes → go straight to **FRAME DROPS**: read each freeze's `cause`, then the
   `coincidence` table to rule phenomena in or out before opening any detail section.
3. **Find the domain** from `main-thread frame time`:
   - `animation / rAF` → **JS-bound** → JS section.
   - `style recalc` / `layout` → **layout-bound** (forced reflow, big recalc; common with
     DOM/React). Check the **REFLOW** section — forced synchronous layout is charged to
     script, so a "forced reflow" finding can explain an `animation`-looking bound.
   - `paint` / `composite` → **rendering-bound** (too many/large layers, layout-animating
     Motion, big repaints). JS will be small — don't chase it.
4. **JS-bound:** read **FILES** before **JS** — first-party ranking tells you which
   subsystem to open, and the app/dependency split tells you whether the lever is your
   code or the number of calls into the engine. Then open the top `APP` functions in
   **JS** for the line. Look for per-frame work that shouldn't repeat: allocation (GC),
   recomputing cacheable values, re-triangulating unchanged geometry, walking the whole
   scene graph. Dependency files (pixi/motion/earcut) show which _subsystem_ is hot even
   when you can't edit it — reduce calls into it. Cross-reference GC
   suspected-allocators against these hot functions.
   **If a top file has no matching row in JS, its cost is in a callback** — grep the
   file for `queueMicrotask` / `requestAnimationFrame` / `.on(` / `subscribe` /
   `useSyncExternalStore` and read the closure it hands over.
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

**Memory leak (MEMORY says `leak likely`):**

- **Listeners climbing** → find the unbalanced registration: an `addEventListener` /
  `.on()` / `subscribe` / `setInterval` / `ResizeObserver`/`IntersectionObserver` /
  ticker callback added on each frame, mount, or update without the paired
  `removeEventListener`/`.off()`/`clearInterval`/`disconnect`/teardown. A screen left on a
  running rAF/ticker that keeps re-subscribing is the classic case.
- **Nodes climbing** → detached DOM kept alive by a lingering JS reference (a cache,
  closure, or array that outlives the node); drop the reference on cleanup.
- **Heap climbing, listeners/nodes flat** → retained JS objects: an ever-growing
  array/map/cache, accumulating closures, or unbounded history/log. Confirm with two
  DevTools heap snapshots (record → snapshot → wait → snapshot → "Objects allocated
  between snapshots") to see exactly which constructor's retained count grew.

## Caveats

- **Dev builds inflate numbers.** `jsxDEV` / `react-dom` dev internals + a big
  engine+native bucket = a dev build with DevTools active. For clean magnitudes,
  recommend a production build without extensions.
- **Extension scripts** (`installHook.js`, a `page.bundle.js`) can appear and be
  mis-tagged `APP`. Treat unfamiliar `file:1` entries skeptically.
- **Pipeline latency ≠ frame interval.** A frame takes a few vsyncs through the
  compositor even when smooth; that's not jank.
