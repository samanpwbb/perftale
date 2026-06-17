import { attributeWindowedSelfTime, type RawProfile } from './profile.ts';
import type { TraceEvent } from './trace-events.ts';

/**
 * Forced synchronous layout (a.k.a. layout thrashing).
 *
 * The browser batches layout: it runs one `Layout`/`UpdateLayoutTree` pass per
 * frame after the rAF callbacks. But if JS *reads* layout geometry
 * (`offsetWidth`, `getBoundingClientRect`, `getComputedStyle`, …) while the DOM
 * is dirty, the browser must flush layout *synchronously, inside script* to
 * answer. That forced pass shows up as a `Layout`/`UpdateLayoutTree` event
 * nested *inside* a `FunctionCall` interval, instead of sitting directly under
 * the frame's `RunTask`. Its cost is charged to script time, so the frame looks
 * "animation/rAF-bound" when it is really paying for synchronous layout — the
 * verdict's aggregate `SendBeginMainFrameToCommit` breakdown can't see it.
 *
 * We recover it structurally: reconstruct main-thread nesting by interval
 * containment, and a layout event is *forced* exactly when some `FunctionCall`
 * contains it. The forcing call carries no callframe in these traces, so the
 * *culprit* JS comes from cross-referencing the run-up to each flush against the
 * CPU profiler — the same windowed attribution the GC model uses
 * (`attributeWindowedSelfTime`). This is the forced-reflow detection DevTools
 * itself performs.
 *
 * Optional, like the GC model: `null` when the trace has no layout events, or
 * when none of them are forced (scheduled-only layout is the common, benign
 * case). The read/write-in-a-loop signature is `worstBurstCount` — the most
 * forced flushes sharing one enclosing call.
 */

export interface ReflowCulprit {
  functionName: string;
  url: string;
  line: number;
  /** JS self-time charged in the run-up to forced layouts (ms). */
  selfMs: number;
  /** Share of attributed run-up JS self-time. */
  sharePct: number;
  app: boolean;
}

export interface ForcedLayout {
  /** `layout` = `Layout` (reflow); `style` = `UpdateLayoutTree` (style recalc). */
  kind: 'layout' | 'style';
  /** Start, ms from trace origin (same reference as the frame/task models). */
  startMs: number;
  durMs: number;
}

export interface ReflowModel {
  mainTid: number | undefined;
  /** Forced `Layout` passes (geometry reflow). */
  forcedLayoutCount: number;
  /** Forced `UpdateLayoutTree` passes (style recalc). */
  forcedStyleCount: number;
  /** Total forced layout + style time (ms) — wall-clock paid inside script. */
  forcedMs: number;
  /** Longest single forced flush (ms). */
  worstMs: number;
  /** Most forced flushes sharing one enclosing call — read/write-in-a-loop. */
  worstBurstCount: number;
  /** Every forced flush, time-ordered (for `--debug`). */
  occurrences: ForcedLayout[];
  /** Heuristic: JS hottest in the run-up to forced layouts — likely the reader. */
  culprits: ReflowCulprit[];
}

export interface ReflowModelOptions {
  /** Trace-origin timestamp (µs) — must match the frame/task models' reference. */
  originUs: number;
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' layout. */
  mainPid?: number;
  /** Renderer main thread (the task model's busiest RunTask thread). */
  mainTid?: number;
  topCulprits?: number;
}

/** True for the events that reconstruct the forced-layout nesting. */
export function isReflowStackEvent(event: TraceEvent): boolean {
  return (
    event.ph === 'X' &&
    (event.name === 'FunctionCall' ||
      event.name === 'Layout' ||
      event.name === 'UpdateLayoutTree')
  );
}

/** Containment epsilon (µs) — a forced layout may share an edge with its call. */
const EPSILON_US = 1;

/**
 * The JS run-up we correlate before each forced flush spans at most this long
 * (µs); in practice it's bounded tighter by the enclosing `FunctionCall`'s
 * start, so this only caps a flush whose forcing call began long before.
 */
const MAX_LOOKBACK_US = 100_000;

interface Interval {
  ts: number;
  end: number;
}

export function buildReflowModel(
  events: TraceEvent[],
  profiles: RawProfile[],
  options: ReflowModelOptions,
): ReflowModel | null {
  if (events.length === 0) return null;
  const warmupEndUs = Math.max(options.warmupEndUs ?? 0, 0);
  const { mainPid, originUs } = options;
  const inProcess = (e: TraceEvent) => mainPid === undefined || e.pid === mainPid;

  // Main thread = the renderer's busiest RunTask thread, passed in from the task
  // model. Fall back to the busiest layout/script thread if it wasn't resolved.
  let mainTid = options.mainTid;
  if (mainTid === undefined) {
    const byThread = new Map<number, number>();
    for (const e of events) {
      if (!inProcess(e) || typeof e.tid !== 'number' || typeof e.dur !== 'number')
        continue;
      byThread.set(e.tid, (byThread.get(e.tid) ?? 0) + e.dur);
    }
    let best = -1;
    for (const [tid, sum] of byThread) {
      if (sum > best) {
        best = sum;
        mainTid = tid;
      }
    }
  }

  const onMain = (e: TraceEvent) =>
    inProcess(e) && e.tid === mainTid && typeof e.dur === 'number' && e.ts >= warmupEndUs;

  // FunctionCall intervals, sorted by start — candidate forcing scopes.
  const calls: Interval[] = events
    .filter((e) => e.name === 'FunctionCall' && onMain(e))
    .map((e) => ({ ts: e.ts, end: e.ts + (e.dur ?? 0) }))
    .sort((a, b) => a.ts - b.ts);

  const layouts = events
    .filter((e) => (e.name === 'Layout' || e.name === 'UpdateLayoutTree') && onMain(e))
    .sort((a, b) => a.ts - b.ts);
  if (layouts.length === 0) return null;

  // The innermost FunctionCall containing [ls, le], or null when none does (= a
  // scheduled lifecycle layout, sitting directly under RunTask). `calls` are
  // sorted by start, so the last container we see is the latest-starting =
  // innermost; any call starting after `ls` cannot contain `ls`, so we stop.
  const enclosingCall = (ls: number, le: number): Interval | null => {
    let inner: Interval | null = null;
    for (const fc of calls) {
      if (fc.ts > ls + EPSILON_US) break;
      if (fc.end >= le - EPSILON_US) inner = fc;
    }
    return inner;
  };

  const occurrences: ForcedLayout[] = [];
  const rawWindows: Interval[] = [];
  const burstByCall = new Map<Interval, number>();
  let forcedLayoutCount = 0;
  let forcedStyleCount = 0;
  let forcedUs = 0;
  let worstUs = 0;

  for (const l of layouts) {
    const dur = l.dur ?? 0;
    const fc = enclosingCall(l.ts, l.ts + dur);
    if (!fc) continue; // scheduled, not forced
    const isStyle = l.name === 'UpdateLayoutTree';
    if (isStyle) forcedStyleCount++;
    else forcedLayoutCount++;
    forcedUs += dur;
    worstUs = Math.max(worstUs, dur);
    burstByCall.set(fc, (burstByCall.get(fc) ?? 0) + 1);
    occurrences.push({
      kind: isStyle ? 'style' : 'layout',
      startMs: (l.ts - originUs) / 1000,
      durMs: dur / 1000,
    });
    // The JS that ran right before the synchronous flush (the geometry read),
    // bounded so the window never escapes the forcing call.
    const startUs = Math.max(fc.ts, l.ts - MAX_LOOKBACK_US);
    if (l.ts > startUs) rawWindows.push({ ts: startUs, end: l.ts });
  }

  if (forcedLayoutCount + forcedStyleCount === 0) return null;

  let worstBurstCount = 0;
  for (const count of burstByCall.values()) {
    worstBurstCount = Math.max(worstBurstCount, count);
  }

  // Merge overlapping/adjacent run-up windows into a disjoint, time-ordered
  // list — bursts in one call produce heavily overlapping windows, and the
  // attribution engine advances a single pointer assuming no overlap.
  rawWindows.sort((a, b) => a.ts - b.ts);
  const windows: Array<{ startUs: number; endUs: number }> = [];
  for (const w of rawWindows) {
    const last = windows[windows.length - 1];
    if (last && w.ts <= last.endUs) {
      last.endUs = Math.max(last.endUs, w.end);
    } else {
      windows.push({ startUs: w.ts, endUs: w.end });
    }
  }

  // The returned WindowedSuspect shape is structurally ReflowCulprit (selfMs is
  // the run-up self-time), so no remapping is needed.
  const culprits: ReflowCulprit[] = attributeWindowedSelfTime(profiles, windows, {
    ...(options.warmupEndUs !== undefined ? { warmupEndUs: options.warmupEndUs } : {}),
    ...(mainPid !== undefined ? { mainPid } : {}),
    top: options.topCulprits ?? 10,
  });

  occurrences.sort((a, b) => a.startMs - b.startMs || b.durMs - a.durMs);

  return {
    mainTid,
    forcedLayoutCount,
    forcedStyleCount,
    forcedMs: forcedUs / 1000,
    worstMs: worstUs / 1000,
    worstBurstCount,
    occurrences,
    culprits,
  };
}
