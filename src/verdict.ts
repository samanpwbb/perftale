import type { FrameModel } from './frames.ts';
import type { GcModel } from './gc.ts';
import type { MemoryModel } from './memory.ts';
import type { HotFile, ProfileModel } from './profile.ts';
import { mostRerendered, type ReactModel } from './react.ts';
import type { ReflowModel } from './reflow.ts';
import { blockingTask, type TaskModel } from './tasks.ts';

/**
 * The conclusions, derived once from the frame/profile/task models so the JSON
 * artifact and the text report share identical interpretation. This is the
 * "here's the problem" an agent reads before the supporting numbers.
 */

export type Bound = 'animation' | 'layout' | 'paint/composite' | 'idle';

/**
 * Anonymous-function share of JS self-time above which the by-function ranking
 * is judged to be under-reporting: below this the scatter across `(anonymous)`
 * rows is noise, above it the ranking is materially wrong and the file rollup
 * is the one to trust. Private — consumers read `Verdict.anonBlindspot`, so the
 * judgment is made once here rather than re-derived per renderer.
 */
const ANON_BLINDSPOT_PCT = 15;

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

/**
 * The heaviest first-party source file. Reported next to `topAppHotspot`
 * because the two can disagree: when a file's cost lives in anonymous
 * callbacks it never surfaces as a top function, so the hottest *function*
 * and the hottest *file* point at different subsystems. When they disagree,
 * the file is usually the better place to start.
 */
export type HotspotFile = Pick<HotFile, 'url' | 'selfMs' | 'sharePct'>;

/**
 * Set when anonymous functions hold enough of JS self-time that the by-function
 * ranking is materially under-reporting — callbacks and closures splinter across
 * many low-ranking `(anonymous)` rows, so the file rollup is the one to read.
 * Null when the scatter is small enough to be noise.
 */
export interface AnonBlindspot {
  /** JS self-time charged to anonymous functions, ms. */
  selfMs: number;
  /** That time as a share of attributed JS self-time. */
  sharePct: number;
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

export interface ReflowVerdict {
  /** Forced `Layout` passes (geometry reflow) inside script. */
  forcedLayoutCount: number;
  /** Forced `UpdateLayoutTree` passes (style recalc) inside script. */
  forcedStyleCount: number;
  /** Wall-clock paid for forced synchronous layout, ms. */
  forcedMs: number;
  /** Most forced flushes in one call — the read/write-in-a-loop signature. */
  worstBurstCount: number;
  /** Heuristic culprit: JS hottest in the run-up to forced layouts, if any. */
  topCulprit: {
    functionName: string;
    url: string;
    line: number;
    selfMs: number;
    app: boolean;
  } | null;
}

export interface MemoryVerdict {
  /** Post-GC heap-floor climb, MB per minute (the live-set growth rate). */
  heapMBPerMin: number;
  /** Heap-floor rise over the analyzed span, MB. */
  heapGrowthMB: number;
  /** Event-listener net rise from the post-cleanup trough (count). */
  listenerGrowth: number;
  /** DOM-node net rise (count). */
  nodeGrowth: number;
  /**
   * Share of the window the main thread was idle (0..1), or null without a CPU
   * profile. Growth while idle is the leak signal; growth under load may be the
   * working set. The discriminator behind `leak`.
   */
  idleFraction: number | null;
  /** Leak confidence: idle growth → likely; growth under load / no profile → possible. */
  leak: 'likely' | 'possible' | 'none';
  /** The most diagnostic growing counter — what to chase first. */
  kind: 'heap' | 'listeners' | 'nodes' | 'documents' | null;
  /** Hottest JS while memory grew — a lead on the source (correlation, not proof). */
  topSuspect: {
    functionName: string;
    url: string;
    line: number;
    selfMs: number;
    app: boolean;
  } | null;
}

export interface ReactVerdict {
  /** Total render spans React DevTools measured in the window. */
  renderCount: number;
  /** Distinct components rendered. */
  componentCount: number;
  /** Wall-clock spent in React renders, ms. */
  totalRenderMs: number;
  /** Heaviest component by self render time. */
  topComponent: { name: string; selfMs: number; count: number } | null;
  /** Component that rendered the most times — the re-render hotspot. */
  mostRerendered: { name: string; count: number } | null;
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
  /**
   * The top first-party *file*, but only when it names a file the `topAppHotspot`
   * function doesn't — that disagreement is the whole signal, and it is a fact
   * about the data rather than a rendering rule. Consumers wanting the hottest
   * app file unconditionally already have `profile.files.app[0]`.
   */
  topAppFile: HotspotFile | null;
  /** Set when the by-function ranking under-reports; see `AnonBlindspot`. */
  anonBlindspot: AnonBlindspot | null;
  /** Forced synchronous layout summary, when any layout was forced. */
  reflow: ReflowVerdict | null;
  /** GC pressure summary, when the trace has v8.gc instrumentation. */
  gc: GcVerdict | null;
  /** Memory-growth summary, when the trace has DevTools Memory counters. */
  memory: MemoryVerdict | null;
  /** React component-render digest, when the trace has DevTools timing. */
  react: ReactVerdict | null;
  /** Caveats that should temper how the numbers are read. */
  notes: string[];
}

function classifyGap(tasks: TaskModel, ms: number, atMs: number): GapVerdict {
  const block = blockingTask(tasks.longTasks, atMs, atMs + ms);
  return { ms, atMs, blocked: block !== null, blockingTaskMs: block?.durMs ?? null };
}

/**
 * The memory note: the measured growth, then the actionable direction keyed off
 * the most diagnostic counter (a listener/node/document climb names a concrete
 * cleanup bug; bare heap growth is the least specific), then the JS lead and how
 * to confirm. "Likely" leans on the idle context; "possible" hedges to working set.
 */
function memoryNote(m: MemoryModel, v: MemoryVerdict): string {
  const span = Math.max(1, Math.round(m.spanMs / 1000));
  const idlePct = v.idleFraction !== null ? `${Math.round(v.idleFraction * 100)}%` : null;

  const facts: string[] = [];
  if (m.heap.growing) {
    facts.push(
      `the JS heap floor rose ~${v.heapMBPerMin.toFixed(0)}MB/min ` +
        `(+${v.heapGrowthMB.toFixed(0)}MB over ${span}s)`,
    );
  }
  if (m.listeners.growing) {
    facts.push(
      `event listeners grew +${v.listenerGrowth} ` +
        `(${m.listeners.min}→${m.listeners.last}, never released)`,
    );
  }
  if (m.nodes.growing)
    facts.push(`DOM nodes climbed +${v.nodeGrowth} (detached, retained)`);
  if (m.documents.growing) {
    facts.push(
      `documents climbed +${Math.round(m.documents.growth)} (detached iframes retained)`,
    );
  }
  const factStr = facts.join('; ');

  let cause: string;
  switch (v.kind) {
    case 'listeners':
      cause =
        ' A listener/subscription/timer is being registered without a matching teardown — ' +
        'search for addEventListener / .on() / subscribe / setInterval / ResizeObserver added ' +
        'per-frame or per-update without the paired removal.';
      break;
    case 'nodes':
      cause =
        ' Detached DOM nodes are kept alive by a lingering JS reference after removal from the document.';
      break;
    case 'documents':
      cause = ' Detached documents/iframes are being retained.';
      break;
    default:
      cause =
        ' Listeners and nodes are flat, so the retained growth is JS objects (closures, caches, ' +
        'ever-growing arrays/maps), not DOM.';
  }

  const lead = v.topSuspect
    ? ` JS running while it grew (a lead, not proof): ${v.topSuspect.functionName}` +
      `${v.topSuspect.app ? ' (app code)' : ' (dependency)'} — start there.`
    : '';

  if (v.leak === 'likely') {
    const idleClause = idlePct
      ? ` while the main thread sat idle ${idlePct} of the time — memory shouldn't climb when nothing is happening`
      : '';
    return (
      `Memory leak (likely): ${factStr}${idleClause}.${cause}${lead} ` +
      `Confirm by diffing two DevTools heap snapshots to see which retained objects grew.`
    );
  }
  const busyClause = idlePct ? ` while the app was busy (${idlePct} idle)` : '';
  return (
    `Possible memory growth: ${factStr}${busyClause} — this may be a growing working set rather ` +
    `than a leak.${cause}${lead} To be sure, record ~30s on an idle/stable screen: if the heap ` +
    `floor keeps climbing with nothing happening, it's a leak.`
  );
}

export function buildVerdict(
  frames: FrameModel,
  profile: ProfileModel | null,
  tasks: TaskModel,
  gc: GcModel | null = null,
  react: ReactModel | null = null,
  reflow: ReflowModel | null = null,
  memory: MemoryModel | null = null,
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

  const appFile = profile?.files.app[0];
  const topAppFile: HotspotFile | null =
    appFile && appFile.url !== topAppHotspot?.url
      ? { url: appFile.url, selfMs: appFile.selfMs, sharePct: appFile.sharePct }
      : null;

  const anonBlindspot: AnonBlindspot | null =
    profile && profile.anonymousSharePct >= ANON_BLINDSPOT_PCT
      ? { selfMs: profile.anonymousMs, sharePct: profile.anonymousSharePct }
      : null;

  const notes: string[] = [];

  let reactVerdict: ReactVerdict | null = null;
  if (react) {
    const top = react.components[0] ?? null;
    const rerender = mostRerendered(react);
    reactVerdict = {
      renderCount: react.renderCount,
      componentCount: react.componentCount,
      totalRenderMs: react.totalRenderMs,
      topComponent: top ? { name: top.name, selfMs: top.selfMs, count: top.count } : null,
      mostRerendered: rerender ? { name: rerender.name, count: rerender.count } : null,
    };
    let note =
      `React: ${react.renderCount} component renders across ${react.componentCount} ` +
      `components (${react.totalRenderMs.toFixed(0)}ms, React DevTools timing)`;
    if (rerender && rerender.count > 1) {
      note +=
        `. Most-rendered: ${rerender.name} ×${rerender.count}` +
        `${top && top.name !== rerender.name ? `; heaviest: ${top.name} (${top.selfMs.toFixed(1)}ms self)` : ''}` +
        ` — frequent re-renders are the usual culprit; check memoization / state placement`;
    } else if (top) {
      note += `. Heaviest: ${top.name} (${top.selfMs.toFixed(1)}ms self)`;
    }
    note +=
      '. Timings include React DevTools recording overhead — capture without DevTools for true frame cost.';
    notes.push(note);
  }

  if (
    fns.some(
      (f) =>
        /jsx-dev-runtime|react-dom(_client)?\.development/.test(f.url) ||
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
  if (anonBlindspot) {
    notes.push(
      `${anonBlindspot.selfMs.toFixed(0)}ms (${anonBlindspot.sharePct.toFixed(0)}%) of JS ` +
        `self-time is in anonymous functions — callbacks and closures, which the ` +
        `by-function ranking splits across many low-ranking \`(anonymous)\` rows. ` +
        `Rank by file (FILES / \`profile.files\`) to see which subsystem that cost belongs to.`,
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

  let memoryVerdict: MemoryVerdict | null = null;
  if (memory) {
    const idleFraction =
      profile && profile.idleMs + profile.activeMs > 0
        ? profile.idleMs / (profile.idleMs + profile.activeMs)
        : null;
    // Prefer an app-code lead for "start here"; fall back to the hottest overall.
    const suspect = memory.suspects.find((s) => s.app) ?? memory.suspects[0] ?? null;
    // Most diagnostic growing counter first: a listener/node/document climb points
    // at a concrete cleanup bug, bare heap growth is the least specific.
    const kind: MemoryVerdict['kind'] = memory.listeners.growing
      ? 'listeners'
      : memory.nodes.growing
        ? 'nodes'
        : memory.documents.growing
          ? 'documents'
          : memory.heap.growing
            ? 'heap'
            : null;
    // Growth while idle is the leak signal; growth under load (or with no activity
    // signal) is hedged to "possible" — it may be a legitimately growing working set.
    const leak: MemoryVerdict['leak'] = !memory.growing
      ? 'none'
      : idleFraction !== null && idleFraction >= 0.5
        ? 'likely'
        : 'possible';
    memoryVerdict = {
      heapMBPerMin: (memory.heap.slopePerSec * 60) / 1e6,
      // Floor rise implied by the rate over the window — consistent with the rate,
      // rather than a raw last−min that would fold in the GC sawtooth.
      heapGrowthMB: (memory.heap.slopePerSec * (memory.spanMs / 1000)) / 1e6,
      listenerGrowth: memory.listeners.growth,
      nodeGrowth: memory.nodes.growth,
      idleFraction,
      leak,
      kind,
      topSuspect: suspect
        ? {
            functionName: suspect.functionName,
            url: suspect.url,
            line: suspect.line,
            selfMs: suspect.selfMs,
            app: suspect.app,
          }
        : null,
    };
    if (leak !== 'none') notes.push(memoryNote(memory, memoryVerdict));
  }

  let reflowVerdict: ReflowVerdict | null = null;
  if (reflow) {
    const culprit = reflow.culprits[0] ?? null;
    reflowVerdict = {
      forcedLayoutCount: reflow.forcedLayoutCount,
      forcedStyleCount: reflow.forcedStyleCount,
      forcedMs: reflow.forcedMs,
      worstBurstCount: reflow.worstBurstCount,
      topCulprit: culprit
        ? {
            functionName: culprit.functionName,
            url: culprit.url,
            line: culprit.line,
            selfMs: culprit.selfMs,
            app: culprit.app,
          }
        : null,
    };
    // Flag when forced layout costs a meaningful slice of a frame, or a single
    // call thrashes in a read/write loop.
    if (reflow.forcedMs >= 4 || reflow.worstBurstCount >= 4) {
      const total = reflow.forcedLayoutCount + reflow.forcedStyleCount;
      const counts =
        `${total} forced reflow${total === 1 ? '' : 's'} ` +
        `(${reflow.forcedLayoutCount} layout + ${reflow.forcedStyleCount} style recalc, ` +
        `${reflow.forcedMs.toFixed(0)}ms)`;
      // When the run-up is dominated by the DevTools extension reading geometry
      // (e.g. React DevTools' measureHostInstance), the forced flush is a capture
      // artifact, not app jank — it won't happen with DevTools detached. Surface
      // it as a caveat rather than misattributing thrashing to the app.
      if (culprit && /-extension:\/\//.test(culprit.url)) {
        notes.push(
          `Forced synchronous layout detected — ${total} reflow${total === 1 ? '' : 's'}, ` +
            `${reflow.forcedMs.toFixed(0)}ms — but the run-up is dominated by a browser ` +
            `DevTools extension (${culprit.functionName}) reading component geometry: a ` +
            `capture artifact that won't occur in production. Re-capture with DevTools ` +
            `detached to measure your app's own forced reflow.`,
        );
      } else {
        // Read/write-in-a-loop bursts = classic thrashing; steady per-frame
        // forced reflow is "forced synchronous layout" without the loop.
        const lead =
          reflow.worstBurstCount >= 2 ? 'Layout thrashing' : 'Forced synchronous layout';
        const parts: string[] = [
          `${lead}: ${counts} — JS read layout geometry mid-frame, forcing the browser ` +
            `to flush layout inside script.`,
        ];
        if (reflow.worstBurstCount >= 2) {
          parts.push(
            `Worst burst: ${reflow.worstBurstCount} forced in one call (read/write in a loop).`,
          );
        }
        if (bound === 'animation') {
          parts.push(
            `That time is charged to script, so ~${reflow.forcedMs.toFixed(0)}ms of the ` +
              `'${bound}' bound is synchronous layout, not animation work.`,
          );
        }
        if (culprit) {
          parts.push(
            `Hottest JS in the run-up (heuristic): ${culprit.functionName}` +
              `${culprit.app ? ' (app code)' : ''} — batch DOM reads before writes ` +
              `(read all geometry first, then write).`,
          );
        }
        notes.push(parts.join(' '));
      }
    }
  }

  const smooth = frames.dropped === 0;
  const hz = frames.refresh.hz;
  let headline: string;
  if (smooth) {
    headline = `${hz}fps, 0 dropped frames`;
    if (bound !== 'idle' && boundSharePct >= 50) {
      headline += ' — running close to budget';
    }
  } else {
    const n = frames.dropped;
    headline = `${hz}fps, ${n} dropped frame${n === 1 ? '' : 's'} (${frames.droppedPct.toFixed(1)}%)`;
    if (worstFreeze) {
      const at = (worstFreeze.atMs / 1000).toFixed(2);
      const block = worstFreeze.blocked
        ? `, blocked by a ${(worstFreeze.blockingTaskMs ?? 0).toFixed(0)}ms task`
        : '';
      headline += ` — worst freeze ${worstFreeze.ms.toFixed(0)}ms at ${at}s${block}`;
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
    topAppFile,
    anonBlindspot,
    reflow: reflowVerdict,
    gc: gcVerdict,
    memory: memoryVerdict,
    react: reactVerdict,
    notes,
  };
}
