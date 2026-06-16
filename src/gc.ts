import {
  correlateAllocators,
  type AllocatorSuspect,
  type RawProfile,
} from './profile.ts';
import type { TraceEvent } from './trace-events.ts';

/**
 * GC pressure from the V8 timeline.
 *
 * V8 emits a synchronous main-thread pause per collection: `MinorGC`
 * (scavenge, young generation) and `MajorGC` (mark-compact, old generation),
 * both `ph:"X"` with a real `dur` and `args.usedHeapSize{Before,After}`. These
 * instrumented durations are more precise than the CPU profiler's sampled
 * `(garbage collector)` bucket, and the heap delta gives the bytes reclaimed.
 *
 * Frequent scavenges reclaiming a lot of young garbage = heavy short-lived
 * allocation — the classic game-loop GC-pressure pattern. We pair the pause
 * stats with a heuristic that points at the JS most likely responsible (see
 * `correlateAllocators`).
 */

export type { AllocatorSuspect } from './profile.ts';

export interface GcPause {
  kind: 'scavenge' | 'mark-compact';
  /** Start, ms from trace origin (same reference as the frame/task models). */
  startMs: number;
  durMs: number;
  /** Heap bytes reclaimed (usedHeapSizeBefore − After, floored at 0). */
  freedBytes: number;
}

export interface GcModel {
  mainTid: number | undefined;
  scavengeCount: number;
  /** Total main-thread scavenge pause time (ms). */
  scavengeMs: number;
  markCompactCount: number;
  /** Total main-thread mark-compact pause time (ms). */
  markCompactMs: number;
  /** Scavenge + mark-compact pause time (ms) — all of it blocks the main thread. */
  totalGcMs: number;
  /** Bytes reclaimed by scavenges ≈ short-lived (young) allocation churn. */
  youngFreedBytes: number;
  /** Scavenges per second over the GC span — the allocation-churn rate. */
  scavengeHz: number;
  /** Longest pauses, biggest first. */
  pauses: GcPause[];
  /** Heuristic: JS hottest in the run-up to scavenges — likely allocators. */
  suspectedAllocators: AllocatorSuspect[];
}

export interface GcModelOptions {
  /** Trace-origin timestamp (µs) — must match the frame/task models' reference. */
  originUs: number;
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' GC. */
  mainPid?: number;
  topPauses?: number;
  topAllocators?: number;
}

/** True for the top-level main-thread GC pause events. */
export function isGcEvent(event: TraceEvent): boolean {
  return (event.name === 'MinorGC' || event.name === 'MajorGC') && event.ph === 'X';
}

/** The mutator run we correlate before a scavenge spans at most this long (µs). */
const MAX_LOOKBACK_US = 100_000;

function freedBytes(event: TraceEvent): number {
  const before = event.args?.['usedHeapSizeBefore'];
  const after = event.args?.['usedHeapSizeAfter'];
  if (typeof before !== 'number' || typeof after !== 'number') return 0;
  return Math.max(0, before - after);
}

export function buildGcModel(
  events: TraceEvent[],
  profiles: RawProfile[],
  options: GcModelOptions,
): GcModel | null {
  if (events.length === 0) return null;
  const warmupEndUs = Math.max(options.warmupEndUs ?? 0, 0);
  const { mainPid, originUs } = options;
  const inProcess = (e: TraceEvent) => mainPid === undefined || e.pid === mainPid;

  // GC main thread = busiest GC thread in the renderer process; the synchronous
  // MinorGC/MajorGC pauses are emitted on the thread where they block.
  const byThread = new Map<number, number>();
  for (const e of events) {
    if (!inProcess(e) || typeof e.tid !== 'number' || typeof e.dur !== 'number') continue;
    byThread.set(e.tid, (byThread.get(e.tid) ?? 0) + e.dur);
  }
  let mainTid: number | undefined;
  let best = -1;
  for (const [tid, sum] of byThread) {
    if (sum > best) {
      best = sum;
      mainTid = tid;
    }
  }

  const gcs = events
    .filter(
      (e) =>
        inProcess(e) &&
        e.tid === mainTid &&
        typeof e.dur === 'number' &&
        e.ts >= warmupEndUs,
    )
    .sort((a, b) => a.ts - b.ts);
  if (gcs.length === 0) return null;

  const pauses: GcPause[] = [];
  const scavengeWindows: Array<{ startUs: number; endUs: number }> = [];
  let scavengeCount = 0;
  let scavengeUs = 0;
  let markCompactCount = 0;
  let markCompactUs = 0;
  let youngFreedBytes = 0;
  let firstUs = Infinity;
  let lastUs = -Infinity;
  // The mutator that filled the nursery ran from the previous GC's end to this
  // one's start; that (capped) window is what we correlate against the profile.
  let prevEndUs = warmupEndUs;

  for (const e of gcs) {
    const dur = e.dur ?? 0;
    const freed = freedBytes(e);
    const scavenge = e.name === 'MinorGC';
    if (scavenge) {
      scavengeCount++;
      scavengeUs += dur;
      youngFreedBytes += freed;
      const startUs = Math.max(prevEndUs, e.ts - MAX_LOOKBACK_US);
      if (e.ts > startUs) scavengeWindows.push({ startUs, endUs: e.ts });
    } else {
      markCompactCount++;
      markCompactUs += dur;
    }
    pauses.push({
      kind: scavenge ? 'scavenge' : 'mark-compact',
      startMs: (e.ts - originUs) / 1000,
      durMs: dur / 1000,
      freedBytes: freed,
    });
    firstUs = Math.min(firstUs, e.ts);
    lastUs = Math.max(lastUs, e.ts);
    prevEndUs = e.ts + dur;
  }

  const spanS = lastUs > firstUs ? (lastUs - firstUs) / 1e6 : 0;
  const scavengeHz = spanS > 0 ? scavengeCount / spanS : 0;

  const suspectedAllocators = correlateAllocators(profiles, scavengeWindows, {
    ...(options.warmupEndUs !== undefined ? { warmupEndUs: options.warmupEndUs } : {}),
    ...(mainPid !== undefined ? { mainPid } : {}),
    top: options.topAllocators ?? 10,
  });

  pauses.sort((a, b) => b.durMs - a.durMs || a.startMs - b.startMs);

  return {
    mainTid,
    scavengeCount,
    scavengeMs: scavengeUs / 1000,
    markCompactCount,
    markCompactMs: markCompactUs / 1000,
    totalGcMs: (scavengeUs + markCompactUs) / 1000,
    youngFreedBytes,
    scavengeHz,
    pauses: pauses.slice(0, options.topPauses ?? 10),
    suspectedAllocators,
  };
}
