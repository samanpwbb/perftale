import type { TraceEvent } from './trace-events.ts';

/**
 * Main-thread long tasks.
 *
 * A presentation gap with no dropped frames is ambiguous: the app might have
 * been idle (nothing to draw) or the main thread might have been blocked. Long
 * `RunTask` events resolve that — if a long task overlaps the gap, the main
 * thread was blocked; otherwise it was genuine idle. Long tasks are also
 * directly actionable on their own (a 480ms task is the thing to fix).
 */

export interface LongTask {
  /** Start, ms from trace origin (same reference as the frame model). */
  startMs: number;
  durMs: number;
}

export interface TaskModel {
  mainTid: number | undefined;
  /** Threshold (ms) above which a RunTask counts as "long". */
  longTaskMs: number;
  /** Long tasks, longest first. */
  longTasks: LongTask[];
  longTaskCount: number;
  totalLongTaskMs: number;
}

export interface TaskModelOptions {
  /** Trace-origin timestamp (µs) — must match the frame model's reference. */
  originUs: number;
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' tasks. */
  mainPid?: number;
  longTaskMs?: number;
  topTasks?: number;
}

/** True for top-level main-thread task events. */
export function isTaskEvent(event: TraceEvent): boolean {
  return event.name === 'RunTask' && event.ph === 'X';
}

export function buildTaskModel(
  events: TraceEvent[],
  options: TaskModelOptions,
): TaskModel {
  const longTaskMs = options.longTaskMs ?? 50;
  const warmupEndUs = Math.max(options.warmupEndUs ?? 0, 0);
  const { mainPid, originUs } = options;
  const inProcess = (e: TraceEvent) => mainPid === undefined || e.pid === mainPid;

  // Main thread = the thread with the most total RunTask time in the process.
  const byThread = new Map<number, number>();
  for (const e of events) {
    if (!inProcess(e)) continue;
    if (typeof e.tid !== 'number' || typeof e.dur !== 'number') continue;
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

  const longTasks: LongTask[] = [];
  for (const e of events) {
    if (!inProcess(e) || e.tid !== mainTid) continue;
    if (typeof e.dur !== 'number' || e.ts < warmupEndUs) continue;
    if (e.dur < longTaskMs * 1000) continue;
    longTasks.push({ startMs: (e.ts - originUs) / 1000, durMs: e.dur / 1000 });
  }
  longTasks.sort((a, b) => b.durMs - a.durMs || a.startMs - b.startMs);

  return {
    mainTid,
    longTaskMs,
    longTasks: longTasks.slice(0, options.topTasks ?? 25),
    longTaskCount: longTasks.length,
    totalLongTaskMs: longTasks.reduce((s, t) => s + t.durMs, 0),
  };
}

/**
 * The long task that most overlaps a [startMs, endMs) window, or null if none.
 * Any frame-blocking task is itself long, so checking `longTasks` is enough to
 * tell a blocked gap from an idle one.
 */
export function blockingTask(
  longTasks: LongTask[],
  startMs: number,
  endMs: number,
): LongTask | null {
  let best: LongTask | null = null;
  let bestOverlap = 0;
  for (const t of longTasks) {
    const overlap = Math.min(t.startMs + t.durMs, endMs) - Math.max(t.startMs, startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t;
    }
  }
  return best;
}
