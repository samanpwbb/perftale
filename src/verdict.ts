import type { FrameModel } from './frames.ts';
import type { GcModel } from './gc.ts';
import type { ProfileModel } from './profile.ts';
import { blockingTask, type TaskModel } from './tasks.ts';

/**
 * The conclusions, derived once from the frame/profile/task models so the JSON
 * artifact and the text report share identical interpretation. This is the
 * "here's the problem" an agent reads before the supporting numbers.
 */

export type Bound = 'animation' | 'layout' | 'paint/composite' | 'idle';

/** Which pipeline domain each main-thread phase belongs to. */
const PHASE_DOMAIN: Record<string, Exclude<Bound, 'idle'>> = {
  animate_us: 'animation',
  handle_input_events_us: 'animation',
  style_update_us: 'layout',
  layout_update_us: 'layout',
  prepaint_us: 'layout',
  compositing_inputs_us: 'layout',
  accessibility_update_us: 'layout',
  paint_us: 'paint/composite',
  update_layers_us: 'paint/composite',
  composite_commit_us: 'paint/composite',
};

export interface GapVerdict {
  ms: number;
  atMs: number;
  /** A long task overlapped the window (main thread blocked) vs benign idle. */
  blocked: boolean;
  blockingTaskMs: number | null;
}

export interface Hotspot {
  functionName: string;
  url: string;
  line: number;
  selfMs: number;
}

export interface GcVerdict {
  /** Main-thread GC pause time (scavenge + mark-compact), ms. */
  totalMs: number;
  scavengeCount: number;
  markCompactCount: number;
  /** Scavenges per second — the allocation-churn rate. */
  scavengeHz: number;
  /** Young garbage reclaimed, MB ≈ short-lived allocation volume. */
  youngFreedMB: number;
  /** Heuristic likely allocator (JS hottest just before scavenges), if any. */
  topSuspect: {
    functionName: string;
    url: string;
    line: number;
    preGcMs: number;
    app: boolean;
  } | null;
}

export interface Verdict {
  /** Zero dropped frames after warmup. */
  smooth: boolean;
  /** One-line conclusion. */
  headline: string;
  /** Dominant main-thread domain, and its share of measured frame time. */
  bound: Bound;
  boundSharePct: number;
  domainsMs: Record<Exclude<Bound, 'idle'>, number>;
  largestGap: GapVerdict;
  /** Present only when frames were dropped. */
  worstFreeze: GapVerdict | null;
  /** The top first-party function to look at, if any. */
  topAppHotspot: Hotspot | null;
  /** GC pressure summary, when the trace has v8.gc instrumentation. */
  gc: GcVerdict | null;
  /** Caveats that should temper how the numbers are read. */
  notes: string[];
}

function classifyGap(tasks: TaskModel, ms: number, atMs: number): GapVerdict {
  const block = blockingTask(tasks.longTasks, atMs, atMs + ms);
  return { ms, atMs, blocked: block !== null, blockingTaskMs: block?.durMs ?? null };
}

export function buildVerdict(
  frames: FrameModel,
  profile: ProfileModel | null,
  tasks: TaskModel,
  gc: GcModel | null = null,
): Verdict {
  const domainsMs: Record<Exclude<Bound, 'idle'>, number> = {
    animation: 0,
    layout: 0,
    'paint/composite': 0,
  };
  for (const phase of frames.mainThread) {
    const domain = PHASE_DOMAIN[phase.key];
    if (domain) domainsMs[domain] += phase.totalMs;
  }
  const totalDomainMs =
    domainsMs.animation + domainsMs.layout + domainsMs['paint/composite'];
  let bound: Bound = 'idle';
  let boundMs = 0;
  for (const [domain, ms] of Object.entries(domainsMs)) {
    if (ms > boundMs) {
      boundMs = ms;
      bound = domain as Exclude<Bound, 'idle'>;
    }
  }
  if (totalDomainMs === 0) bound = 'idle';
  const boundSharePct = totalDomainMs > 0 ? (boundMs / totalDomainMs) * 100 : 0;

  const largestGap = classifyGap(tasks, frames.largestGapMs, frames.largestGapAtMs);
  const worstFreeze =
    frames.dropped > 0
      ? classifyGap(tasks, frames.worstFreezeMs, frames.worstFreezeAtMs)
      : null;

  const fns = profile?.functions ?? [];
  const app = fns.find((f) => f.app);
  const topAppHotspot: Hotspot | null = app
    ? { functionName: app.functionName, url: app.url, line: app.line, selfMs: app.selfMs }
    : null;

  const notes: string[] = [];
  if (
    fns.some(
      (f) =>
        /jsx-dev-runtime|react-dom_client/.test(f.url) ||
        f.functionName === 'exports.jsxDEV',
    )
  ) {
    notes.push(
      'Dev build detected (React dev runtime) — record a production build for representative numbers.',
    );
  }
  if (fns.some((f) => /-extension:\/\//.test(f.url))) {
    notes.push(
      'Browser extensions were active during capture — engine/native time is inflated.',
    );
  }
  if (profile && profile.nativeMs > profile.jsMs * 2) {
    notes.push(
      `Large engine/native bucket (${profile.nativeMs.toFixed(0)}ms) — much of it is ` +
        `console-instrumentation overhead from recording with DevTools attached; ` +
        `real app JS is ${profile.jsMs.toFixed(0)}ms.`,
    );
  }

  let gcVerdict: GcVerdict | null = null;
  if (gc) {
    const suspect = gc.suspectedAllocators[0] ?? null;
    gcVerdict = {
      totalMs: gc.totalGcMs,
      scavengeCount: gc.scavengeCount,
      markCompactCount: gc.markCompactCount,
      scavengeHz: gc.scavengeHz,
      youngFreedMB: gc.youngFreedBytes / 1e6,
      topSuspect: suspect
        ? {
            functionName: suspect.functionName,
            url: suspect.url,
            line: suspect.line,
            preGcMs: suspect.preGcMs,
            app: suspect.app,
          }
        : null,
    };
    // Flag GC when it costs ~a frame or fires often enough to cause micro-stutter.
    if (gc.totalGcMs >= 16 || gc.scavengeHz >= 2) {
      const freed = gc.youngFreedBytes / 1e6;
      let note =
        `GC pressure: ${gc.scavengeCount} scavenge${gc.scavengeCount === 1 ? '' : 's'} ` +
        `(${gc.scavengeHz.toFixed(1)}/s${freed >= 1 ? `, ~${freed.toFixed(0)}MB young garbage` : ''})` +
        `${gc.markCompactCount > 0 ? ` + ${gc.markCompactCount} mark-compact` : ''} ` +
        `cost ${gc.totalGcMs.toFixed(0)}ms of main-thread pauses.`;
      if (suspect) {
        note +=
          ` Hottest JS before scavenges (heuristic): ${suspect.functionName} — ` +
          `likely high allocation. Reduce per-frame allocations (pool/reuse objects); ` +
          `confirm with a heap allocation profile.`;
      }
      notes.push(note);
    }
  }

  const smooth = frames.dropped === 0;
  const hz = frames.refresh.hz;
  let headline: string;
  if (smooth) {
    headline = `Smooth at ${hz}fps (0 dropped frames)`;
    headline +=
      bound !== 'idle' && boundSharePct >= 50
        ? ` — but ${boundSharePct.toFixed(0)}% of main-thread frame time is ${bound}; running close to budget.`
        : '.';
  } else {
    headline = `Janky: ${frames.dropped} dropped frames (${frames.droppedPct.toFixed(1)}%)`;
    if (worstFreeze?.blocked) {
      headline += `; worst freeze ${worstFreeze.ms.toFixed(0)}ms at ${(worstFreeze.atMs / 1000).toFixed(2)}s, blocked by a ${(worstFreeze.blockingTaskMs ?? 0).toFixed(0)}ms task.`;
    } else if (worstFreeze) {
      headline += `; worst freeze ${worstFreeze.ms.toFixed(0)}ms at ${(worstFreeze.atMs / 1000).toFixed(2)}s.`;
    } else {
      headline += '.';
    }
  }

  return {
    smooth,
    headline,
    bound,
    boundSharePct,
    domainsMs,
    largestGap,
    worstFreeze,
    topAppHotspot,
    gc: gcVerdict,
    notes,
  };
}
