import type { TraceEvent } from './trace-events.ts';

/**
 * Frame model.
 *
 * Smoothness for animation-heavy apps is about *throughput* (did a fresh frame
 * reach the screen every vsync?), not pipeline *latency*. So we model:
 *
 *  - refresh rate, detected from BeginFrame cadence (one BeginFrame per vsync);
 *  - dropped frames, from the authoritative `DroppedFrame` instant events;
 *  - freezes, as the screen-frozen span around each dropped-frame cluster, so
 *    idle stretches (long `DrawFrame` gaps with no drops) never count as jank;
 *  - where main-thread frame time goes, from the per-frame micro-breakdown
 *    carried by `SendBeginMainFrameToCommit` (style/layout/paint/animate/...).
 *
 * Pipeline latency (PipelineReporter begin→end) is reported too, but clearly
 * labelled as latency — it is normally a few vsyncs deep even when smooth.
 */

const FRAME_EVENT_NAMES = new Set([
  'BeginFrame',
  'DrawFrame',
  'DroppedFrame',
  'PipelineReporter',
  'SendBeginMainFrameToCommit',
]);

/** True for the small subset of events the frame model needs to buffer. */
export function isFrameEvent(event: TraceEvent): boolean {
  return FRAME_EVENT_NAMES.has(event.name ?? '');
}

/** Main-thread phases inside SendBeginMainFrameToCommit, with friendly labels. */
const MAIN_THREAD_PHASES: Record<string, string> = {
  handle_input_events_us: 'input handlers',
  animate_us: 'animation / rAF callbacks',
  style_update_us: 'style recalc',
  layout_update_us: 'layout',
  prepaint_us: 'pre-paint',
  compositing_inputs_us: 'compositing inputs',
  paint_us: 'paint',
  update_layers_us: 'update layers',
  composite_commit_us: 'composite commit',
  accessibility_update_us: 'accessibility',
};

// Unset breakdown fields show up as a uint64 wraparound (~1.8e19); anything
// this large is a sentinel, not real work.
const SENTINEL_US = 1e12;

const COMMON_REFRESH_HZ = [30, 48, 60, 72, 90, 120, 144, 165, 240];

export interface RefreshInfo {
  hz: number;
  intervalMs: number;
  source: 'detected' | 'override' | 'default';
  /** Fraction of BeginFrame intervals within 10% of the median (0..1). */
  confidence: number;
}

export interface MainThreadPhase {
  key: string;
  label: string;
  totalMs: number;
  /** Share of total measured main-thread frame work. */
  sharePct: number;
}

export interface DroppedCluster {
  startMs: number;
  endMs: number;
  count: number;
}

export interface FrameModel {
  refresh: RefreshInfo;
  windowMs: number;
  /** Frames that reached the screen (DrawFrame events). */
  presented: number;
  /** Dropped frames (DroppedFrame events). */
  dropped: number;
  /** dropped / (presented + dropped). */
  droppedPct: number;
  /** Average presentation rate over the window (includes idle vsyncs — see note). */
  presentationFps: number;
  /**
   * Longest *frozen* span: the largest gap between presented frames that
   * actually contained a dropped frame (so idle stretches don't count).
   */
  worstFreezeMs: number;
  worstFreezeAtMs: number;
  /** Number of presentation gaps that contained at least one dropped frame. */
  jankGapCount: number;
  /**
   * Largest presentation gap overall, regardless of drops. May be benign idle
   * OR a main-thread block — the task model (later step) tells them apart.
   */
  largestGapMs: number;
  largestGapAtMs: number;
  /** Where main-thread frame time went, biggest first. */
  mainThread: MainThreadPhase[];
  /** Pipeline latency (begin→present), NOT frame interval. */
  pipelineLatencyMs: { p50: number; p95: number; max: number };
  /** Time windows where dropped frames bunched together. */
  droppedClusters: DroppedCluster[];
}

export interface FrameModelOptions {
  /** Override the detected refresh rate (e.g. when capture vsync is ambiguous). */
  fps?: number;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function percentile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0;
}

function detectRefresh(beginFrameTsUs: number[], fpsOverride?: number): RefreshInfo {
  if (fpsOverride && fpsOverride > 0) {
    return {
      hz: fpsOverride,
      intervalMs: 1000 / fpsOverride,
      source: 'override',
      confidence: 1,
    };
  }

  const deltas: number[] = [];
  for (let i = 1; i < beginFrameTsUs.length; i++) {
    const d = (beginFrameTsUs[i] ?? 0) - (beginFrameTsUs[i - 1] ?? 0);
    if (d > 0) deltas.push(d);
  }
  if (deltas.length < 2) {
    return { hz: 60, intervalMs: 1000 / 60, source: 'default', confidence: 0 };
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const medUs = median(sorted);
  const near = deltas.filter((d) => Math.abs(d - medUs) <= medUs * 0.1).length;
  const rawHz = 1_000_000 / medUs;
  const hz = COMMON_REFRESH_HZ.find((h) => Math.abs(h - rawHz) <= 2) ?? Math.round(rawHz);

  return {
    hz,
    intervalMs: 1000 / hz,
    source: 'detected',
    confidence: near / deltas.length,
  };
}

/** Pair PipelineReporter begin/end by id2.local to get per-frame pipeline latency. */
function pipelineLatencies(events: TraceEvent[]): number[] {
  const open = new Map<string, number[]>();
  const durationsUs: number[] = [];
  for (const ev of events) {
    if (ev.name !== 'PipelineReporter') continue;
    const id = ev.id2?.local ?? ev.id2?.global ?? ev.id ?? '?';
    if (ev.ph === 'b') {
      let stack = open.get(id);
      if (!stack) {
        stack = [];
        open.set(id, stack);
      }
      stack.push(ev.ts);
    } else if (ev.ph === 'e') {
      const start = open.get(id)?.pop();
      if (start !== undefined) durationsUs.push(ev.ts - start);
    }
  }
  return durationsUs.sort((a, b) => a - b);
}

interface ClusterUs {
  startUs: number;
  endUs: number;
  count: number;
}

/** Group dropped frames that fall within 100ms of each other into one hitch. */
function clusterDropped(droppedTsUs: number[]): ClusterUs[] {
  if (droppedTsUs.length === 0) return [];
  const gapUs = 100_000;
  const clusters: ClusterUs[] = [];
  let start = droppedTsUs[0] ?? 0;
  let prev = start;
  let count = 1;
  for (let i = 1; i < droppedTsUs.length; i++) {
    const ts = droppedTsUs[i] ?? 0;
    if (ts - prev > gapUs) {
      clusters.push({ startUs: start, endUs: prev, count });
      start = ts;
      count = 0;
    }
    prev = ts;
    count++;
  }
  clusters.push({ startUs: start, endUs: prev, count });
  return clusters;
}

/** Largest value <= t (sorted ascending), or null if none. */
function lastAtOrBefore(sorted: number[], t: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] ?? 0;
    if (v <= t) {
      ans = v;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Smallest value >= t (sorted ascending), or null if none. */
function firstAtOrAfter(sorted: number[], t: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] ?? 0;
    if (v >= t) {
      ans = v;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/**
 * Build the frame model from the buffered frame events (a tiny subset of the
 * trace). Pure and deterministic.
 */
export function buildFrameModel(
  events: TraceEvent[],
  options: FrameModelOptions = {},
): FrameModel {
  const beginFrameTs: number[] = [];
  const drawFrameTs: number[] = [];
  const droppedTs: number[] = [];
  const mainThreadUs = new Map<string, number>();

  for (const ev of events) {
    switch (ev.name) {
      case 'BeginFrame':
        if (ev.ph === 'I') beginFrameTs.push(ev.ts);
        break;
      case 'DrawFrame':
        if (ev.ph === 'I') drawFrameTs.push(ev.ts);
        break;
      case 'DroppedFrame':
        if (ev.ph === 'I') droppedTs.push(ev.ts);
        break;
      case 'SendBeginMainFrameToCommit': {
        if (ev.ph !== 'b') break;
        const bd = ev.args?.['send_begin_mainframe_to_commit_breakdown'];
        if (bd && typeof bd === 'object') {
          for (const [key, val] of Object.entries(bd as Record<string, unknown>)) {
            if (
              key in MAIN_THREAD_PHASES &&
              typeof val === 'number' &&
              val > 0 &&
              val < SENTINEL_US
            ) {
              mainThreadUs.set(key, (mainThreadUs.get(key) ?? 0) + val);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  beginFrameTs.sort((a, b) => a - b);
  drawFrameTs.sort((a, b) => a - b);
  droppedTs.sort((a, b) => a - b);

  const refresh = detectRefresh(beginFrameTs, options.fps);

  // Presentation cadence: prefer DrawFrame; fall back to BeginFrame.
  const cadence = drawFrameTs.length >= 2 ? drawFrameTs : beginFrameTs;
  const allTs = [...beginFrameTs, ...drawFrameTs, ...droppedTs];
  const originUs = allTs.length ? Math.min(...allTs) : 0;
  const endUs = allTs.length ? Math.max(...allTs) : 0;
  const windowMs = (endUs - originUs) / 1000;

  // Largest presentation gap overall. May be benign idle OR a main-thread
  // block — the task model disambiguates that later.
  let largestGapUs = 0;
  let largestGapAtUs = originUs;
  for (let i = 1; i < cadence.length; i++) {
    const a = cadence[i - 1] ?? 0;
    const delta = (cadence[i] ?? 0) - a;
    if (delta > largestGapUs) {
      largestGapUs = delta;
      largestGapAtUs = a;
    }
  }

  // Each dropped-frame cluster is a freeze: the screen was stuck from the last
  // presented frame before the cluster to the first one after it. This counts
  // actual drops, so idle gaps never masquerade as freezes, and it handles
  // leading/trailing drops that aren't bracketed by presented frames.
  const clustersUs = clusterDropped(droppedTs);
  let worstFreezeUs = 0;
  let worstFreezeAtUs = originUs;
  for (const c of clustersUs) {
    const lo = lastAtOrBefore(drawFrameTs, c.startUs) ?? c.startUs;
    const hi = firstAtOrAfter(drawFrameTs, c.endUs) ?? c.endUs;
    const span = Math.max(hi - lo, c.endUs - c.startUs);
    if (span > worstFreezeUs) {
      worstFreezeUs = span;
      worstFreezeAtUs = lo;
    }
  }
  const droppedClusters: DroppedCluster[] = clustersUs.map((c) => ({
    startMs: (c.startUs - originUs) / 1000,
    endMs: (c.endUs - originUs) / 1000,
    count: c.count,
  }));

  const presented = drawFrameTs.length;
  const dropped = droppedTs.length;
  const denom = presented + dropped;

  const totalMainUs = [...mainThreadUs.values()].reduce((a, b) => a + b, 0);
  const mainThread: MainThreadPhase[] = [...mainThreadUs.entries()]
    .map(([key, us]) => ({
      key,
      label: MAIN_THREAD_PHASES[key] ?? key,
      totalMs: us / 1000,
      sharePct: totalMainUs ? (us / totalMainUs) * 100 : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || (a.key < b.key ? -1 : 1));

  const latencies = pipelineLatencies(events);

  return {
    refresh,
    windowMs,
    presented,
    dropped,
    droppedPct: denom ? (dropped / denom) * 100 : 0,
    presentationFps: windowMs > 0 ? presented / (windowMs / 1000) : 0,
    worstFreezeMs: worstFreezeUs / 1000,
    worstFreezeAtMs: (worstFreezeAtUs - originUs) / 1000,
    jankGapCount: clustersUs.length,
    largestGapMs: largestGapUs / 1000,
    largestGapAtMs: (largestGapAtUs - originUs) / 1000,
    mainThread,
    pipelineLatencyMs: {
      p50: percentile(latencies, 0.5) / 1000,
      p95: percentile(latencies, 0.95) / 1000,
      max: (latencies.at(-1) ?? 0) / 1000,
    },
    droppedClusters,
  };
}
