import type { TraceEvent } from './trace-events.ts';

/**
 * JS attribution from the V8 CPU profiler.
 *
 * The profiler emits a `Profile` root (with a start time) and a stream of
 * `ProfileChunk`s sharing its id. Each chunk carries:
 *   - `cpuProfile.nodes`  — call-tree nodes ({id, parent, callFrame});
 *   - `cpuProfile.samples` — the leaf node id sampled at each tick;
 *   - `timeDeltas`        — µs since the previous sample.
 *
 * Self-time = charge each tick's delta to the leaf function sampled at that
 * tick (where the CPU actually was). Idle and GC get their own buckets; native
 * frames with no JS source land in the `native` bucket. That bucket also
 * absorbs console-instrumentation overhead (`createTask`/`run`) present because
 * the trace was recorded with DevTools attached — we keep it labelled rather
 * than folding it into JS callers, where it would masquerade as app cost.
 *
 * The same self-time is rolled up twice, because the two rollups answer
 * different questions:
 *
 *   - by function (`functions`) — which line to open;
 *   - by source url (`files`)   — which subsystem is expensive.
 *
 * The file rollup is not a convenience view. The function rollup has a
 * systematic blind spot: cost that lives in callbacks and closures is reported
 * as `(anonymous)` and splinters across many low-ranking rows, so a file whose
 * whole cost sits in one `queueMicrotask` callback can be the most expensive
 * first-party file in the trace and still never appear in the top functions.
 * Callback-heavy code — schedulers, event emitters, store fan-out, framework
 * internals — is exactly where that happens. `anonymousMs` measures how much of
 * the trace is exposed to the blind spot, so the report can say when the
 * function table is under-reporting.
 */

export interface CallFrame {
  functionName?: string | undefined;
  url?: string | undefined;
  lineNumber?: number | undefined;
  columnNumber?: number | undefined;
  codeType?: string | undefined;
}

export interface RawProfile {
  id: string;
  pid: number | undefined;
  tid: number | undefined;
  startUs: number;
  frames: Map<number, CallFrame>;
  parents: Map<number, number>;
  samples: number[];
  deltas: number[];
}

export interface HotFunction {
  functionName: string;
  url: string;
  /** 1-based line / column for display. */
  line: number;
  col: number;
  selfMs: number;
  /** Share of attributed JS self-time. */
  sharePct: number;
  /** True when the source is app code rather than a dependency. */
  app: boolean;
}

/** Self-time rolled up to one source file (`callFrame.url`). */
export interface HotFile {
  /** Full source url, as the profiler reported it. */
  url: string;
  selfMs: number;
  /** Share of attributed JS self-time. */
  sharePct: number;
  /** True when the source is app code rather than a dependency. */
  app: boolean;
  /** Distinct functions charged to this file — 1 means the cost is one place. */
  functionCount: number;
  /** Of `selfMs`, how much landed in anonymous functions (the blind spot). */
  anonymousMs: number;
}

export interface ProfileModel {
  tid: number | undefined;
  sampleCount: number;
  /** Non-idle sampled time. */
  activeMs: number;
  idleMs: number;
  gcMs: number;
  /** Native/engine frames with no JS source (incl. console-instrumentation overhead). */
  nativeMs: number;
  /** Time charged to JS functions with source. */
  jsMs: number;
  /** Hottest JS functions by self-time, biggest first. */
  functions: HotFunction[];
  /**
   * The same self-time rolled up by source file, each group ranked biggest
   * first and truncated to `topFiles` independently — so an engine that
   * dominates the trace can't crowd out the first-party files.
   */
  files: { app: HotFile[]; dep: HotFile[] };
  /** JS self-time in first-party files (across all files, not just the top ones). */
  appMs: number;
  /** `appMs` as a share of attributed JS self-time. */
  appSharePct: number;
  /** JS self-time in bundled dependencies — the engine/library cost. */
  depMs: number;
  /** `depMs` as a share of attributed JS self-time. */
  depSharePct: number;
  /** Distinct source files charged any JS self-time. */
  fileCount: number;
  /** JS self-time charged to anonymous functions — under-reported by `functions`. */
  anonymousMs: number;
  /** `anonymousMs` as a share of attributed JS self-time. */
  anonymousSharePct: number;
}

export interface ProfileModelOptions {
  warmupEndUs?: number;
  topFunctions?: number;
  /** Files kept per group — first-party and dependency are ranked separately. */
  topFiles?: number;
  /** Renderer process id (from the frame events) — selects the app's profile. */
  mainPid?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}
function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** First-party source — not a dependency, browser extension, or injected tool. */
function isAppCode(url: string): boolean {
  if (url === '') return false;
  // React/Redux DevTools and other extensions inject scripts into the page
  // (chrome-extension:// / moz-extension:// / safari-web-extension://).
  if (/-extension:\/\//.test(url)) return false;
  // bundled dependencies
  if (/node_modules|\/\.vite\/|\/deps\//.test(url)) return false;
  return true;
}

/** True for the CPU-profiler events the attribution model consumes. */
export function isProfileEvent(event: TraceEvent): boolean {
  return event.ph === 'P' && (event.name === 'Profile' || event.name === 'ProfileChunk');
}

/** Accumulates Profile/ProfileChunk events during the streaming pass. */
export class ProfileCollector {
  private readonly profiles = new Map<string, RawProfile>();

  // Profile ids are only unique within a process, and traces recorded with
  // browser extensions active contain profiles from several processes. Key by
  // pid+id so unrelated profiles are never merged into one.
  private ensure(event: TraceEvent, id: string): RawProfile {
    const key = `${event.pid ?? '?'}:${id}`;
    let p = this.profiles.get(key);
    if (!p) {
      p = {
        id,
        pid: event.pid,
        tid: undefined,
        startUs: 0,
        frames: new Map(),
        parents: new Map(),
        samples: [],
        deltas: [],
      };
      this.profiles.set(key, p);
    }
    return p;
  }

  add(event: TraceEvent): void {
    if (event.ph !== 'P') return;
    const id = asString(event.id) ?? '?';
    const data = asRecord(asRecord(event.args)?.['data']);

    if (event.name === 'Profile') {
      const p = this.ensure(event, id);
      p.tid = event.tid;
      p.startUs = asNumber(data?.['startTime']) ?? event.ts;
      return;
    }
    if (event.name !== 'ProfileChunk') return;

    const p = this.ensure(event, id);
    const cpu = asRecord(data?.['cpuProfile']);
    for (const raw of asArray(cpu?.['nodes']) ?? []) {
      const node = asRecord(raw);
      const nodeId = asNumber(node?.['id']);
      if (nodeId === undefined) continue;
      const cf = asRecord(node?.['callFrame']) ?? {};
      p.frames.set(nodeId, {
        functionName: asString(cf['functionName']),
        url: asString(cf['url']),
        lineNumber: asNumber(cf['lineNumber']),
        columnNumber: asNumber(cf['columnNumber']),
        codeType: asString(cf['codeType']),
      });
      const parent = asNumber(node?.['parent']);
      if (parent !== undefined) p.parents.set(nodeId, parent);
    }
    for (const s of asArray(cpu?.['samples']) ?? asArray(data?.['samples']) ?? []) {
      const n = asNumber(s);
      if (n !== undefined) p.samples.push(n);
    }
    for (const d of asArray(data?.['timeDeltas']) ?? asArray(cpu?.['timeDeltas']) ?? []) {
      const n = asNumber(d);
      if (n !== undefined) p.deltas.push(n);
    }
  }

  list(): RawProfile[] {
    return [...this.profiles.values()];
  }
}

type Target =
  | { kind: 'idle' | 'gc' | 'native' }
  | {
      kind: 'js';
      key: string;
      fn: string;
      url: string;
      line: number;
      col: number;
      app: boolean;
      /** The profiler reported no function name — a callback/closure/arrow. */
      anon: boolean;
    };

const IDLE_TARGET: Target = { kind: 'idle' };
const GC_TARGET: Target = { kind: 'gc' };
const NATIVE_TARGET: Target = { kind: 'native' };

/** Resolve a sampled node to where its time should be charged (memoized per node). */
function resolveTarget(
  profile: RawProfile,
  nodeId: number,
  memo: Map<number, Target>,
): Target {
  const cached = memo.get(nodeId);
  if (cached) return cached;

  const frame = profile.frames.get(nodeId);
  const fn = frame?.functionName ?? '';
  let target: Target;

  if (fn === '(idle)') {
    target = IDLE_TARGET;
  } else if (fn === '(garbage collector)') {
    target = GC_TARGET;
  } else if (frame?.url && frame.codeType === 'JS') {
    const url = frame.url;
    const line = (frame.lineNumber ?? 0) + 1;
    const col = (frame.columnNumber ?? 0) + 1;
    // The profiler reports callbacks/closures with no name. Record that as a
    // fact here rather than re-reading it off the display label downstream.
    const anon = !frame.functionName;
    const name = frame.functionName || '(anonymous)';
    target = {
      kind: 'js',
      key: `${name}@${url}:${line}`,
      fn: name,
      url,
      line,
      col,
      app: isAppCode(url),
      anon,
    };
  } else {
    target = NATIVE_TARGET;
  }

  memo.set(nodeId, target);
  return target;
}

/** Non-idle sampled time on a profile — used to pick the busiest (main) thread. */
function activeTime(p: RawProfile): number {
  let sum = 0;
  const n = Math.min(p.samples.length, p.deltas.length);
  for (let i = 0; i < n; i++) {
    const fn = p.frames.get(p.samples[i] ?? -1)?.functionName ?? '';
    if (fn !== '(idle)') sum += p.deltas[i] ?? 0;
  }
  return sum;
}

/**
 * The renderer main thread's profile: prefer the renderer process (where the
 * frames came from) so a busy browser-extension profile can't win, then take
 * the thread with the most working (non-idle) time.
 */
function pickMainProfile(
  profiles: RawProfile[],
  mainPid: number | undefined,
): RawProfile | null {
  if (profiles.length === 0) return null;
  const sameProcess = profiles.filter((p) => p.pid === mainPid);
  const candidates =
    mainPid !== undefined && sameProcess.length > 0 ? sameProcess : profiles;
  let main = candidates[0]!;
  let mainActive = activeTime(main);
  for (const p of candidates.slice(1)) {
    const a = activeTime(p);
    if (a > mainActive) {
      main = p;
      mainActive = a;
    }
  }
  return main;
}

/**
 * Absolute per-sample timestamps in time order. V8 emits some out-of-order
 * samples (negative deltas); reconstructing then sorting lets callers charge
 * each non-negative inter-sample gap to the sample running during it, instead
 * of letting negatives subtract from a function's total.
 */
function buildTimeline(main: RawProfile): { tsArr: Float64Array; order: number[] } {
  const n = Math.min(main.samples.length, main.deltas.length);
  const tsArr = new Float64Array(n);
  let acc = main.startUs;
  for (let i = 0; i < n; i++) {
    acc += main.deltas[i] ?? 0;
    tsArr[i] = acc;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (tsArr[a] ?? 0) - (tsArr[b] ?? 0),
  );
  return { tsArr, order };
}

/**
 * In-loop accumulator for one function, converted to `HotFunction` on the way
 * out — so neither field below reaches the JSON.
 *
 * Holds integer µs rather than ms: sample deltas are whole µs, so summing them
 * is exact and the single divide at the end yields the shortest correct decimal
 * (accumulating ms instead lets rounding error surface in the goldens). Carries
 * `anon` so the file rollup can be derived afterwards without re-reading
 * anonymity off the `(anonymous)` display label — the profiler's "no name" fact
 * stays a fact, not a string comparison.
 */
interface FnAcc extends Omit<HotFunction, 'selfMs' | 'sharePct'> {
  selfUs: number;
  anon: boolean;
}

/**
 * Build the JS-attribution model from the collected profiles. Picks the
 * busiest thread (the renderer main thread) and ranks functions by self-time,
 * and — from the same samples — by source file.
 */
export function buildProfileModel(
  profiles: RawProfile[],
  options: ProfileModelOptions = {},
): ProfileModel | null {
  const main = pickMainProfile(profiles, options.mainPid);
  if (!main) return null;

  const warmupEndUs = options.warmupEndUs ?? 0;
  const analysisStartUs = Math.max(warmupEndUs, main.startUs);

  const memo = new Map<number, Target>();
  const selfUs = new Map<string, FnAcc>();
  let idleUs = 0;
  let gcUs = 0;
  let nativeUs = 0;
  let jsUs = 0;
  let sampleCount = 0;

  // Charge each non-negative inter-sample gap to the sample running during it,
  // in time order (V8 emits some out-of-order samples — see buildTimeline).
  const { tsArr, order } = buildTimeline(main);

  for (let k = 0; k < order.length; k++) {
    const i = order[k] ?? 0;
    const tStart = tsArr[i] ?? 0;
    if (tStart < analysisStartUs) continue;
    const tNext = k + 1 < order.length ? (tsArr[order[k + 1] ?? 0] ?? tStart) : tStart;
    const dt = Math.max(0, tNext - tStart);

    const target = resolveTarget(main, main.samples[i] ?? -1, memo);
    sampleCount++;
    switch (target.kind) {
      case 'idle':
        idleUs += dt;
        break;
      case 'gc':
        gcUs += dt;
        break;
      case 'native':
        nativeUs += dt;
        break;
      case 'js': {
        jsUs += dt;
        const existing = selfUs.get(target.key);
        if (existing) {
          existing.selfUs += dt;
        } else {
          selfUs.set(target.key, {
            functionName: target.fn,
            url: target.url,
            line: target.line,
            col: target.col,
            selfUs: dt,
            app: target.app,
            anon: target.anon,
          });
        }
        break;
      }
    }
  }

  const jsMs = jsUs / 1000;
  const share = (ms: number) => (jsMs > 0 ? (ms / jsMs) * 100 : 0);
  const attributed = [...selfUs.values()];
  // Rank and truncate on the accumulators, then build output rows only for the
  // survivors — a trace holds hundreds to thousands of distinct functions and
  // files, and all but the top few of each would be immediate garbage.
  const keyOf = (f: FnAcc) => `${f.functionName}@${f.url}:${f.line}`;
  const functions: HotFunction[] = attributed
    .sort((a, b) => b.selfUs - a.selfUs || (keyOf(a) < keyOf(b) ? -1 : 1))
    .slice(0, options.topFunctions ?? 25)
    .map(({ anon: _anon, selfUs: us, ...f }) => ({
      ...f,
      selfMs: us / 1000,
      sharePct: share(us / 1000),
    }));

  // The file rollup falls out of the functions already accumulated — every
  // function belongs to exactly one url — so it costs one pass over the
  // distinct functions rather than any work per sample.
  type FileAcc = Omit<HotFile, 'selfMs' | 'sharePct' | 'anonymousMs'> & {
    selfUs: number;
    anonUs: number;
  };
  const fileMap = new Map<string, FileAcc>();
  let appUs = 0;
  let anonUs = 0;
  for (const fn of attributed) {
    if (fn.app) appUs += fn.selfUs;
    if (fn.anon) anonUs += fn.selfUs;
    let file = fileMap.get(fn.url);
    if (!file) {
      file = { url: fn.url, selfUs: 0, app: fn.app, functionCount: 0, anonUs: 0 };
      fileMap.set(fn.url, file);
    }
    file.selfUs += fn.selfUs;
    file.functionCount++;
    if (fn.anon) file.anonUs += fn.selfUs;
  }
  // Split as the map drains rather than ranking the union and filtering it
  // twice: the two groups are ranked and truncated independently anyway, so a
  // merged ranking is work whose result is thrown away.
  const appFiles: FileAcc[] = [];
  const depFiles: FileAcc[] = [];
  for (const file of fileMap.values()) (file.app ? appFiles : depFiles).push(file);
  const topFiles = options.topFiles ?? 20;
  const rank = (group: FileAcc[]): HotFile[] =>
    group
      .sort((a, b) => b.selfUs - a.selfUs || (a.url < b.url ? -1 : 1))
      .slice(0, topFiles)
      .map((f) => ({
        url: f.url,
        selfMs: f.selfUs / 1000,
        sharePct: share(f.selfUs / 1000),
        app: f.app,
        functionCount: f.functionCount,
        anonymousMs: f.anonUs / 1000,
      }));
  const appMs = appUs / 1000;
  const depMs = (jsUs - appUs) / 1000;

  return {
    tid: main.tid,
    sampleCount,
    activeMs: (gcUs + nativeUs + jsUs) / 1000,
    idleMs: idleUs / 1000,
    gcMs: gcUs / 1000,
    nativeMs: nativeUs / 1000,
    jsMs,
    functions,
    files: { app: rank(appFiles), dep: rank(depFiles) },
    appMs,
    appSharePct: share(appMs),
    depMs,
    depSharePct: share(depMs),
    fileCount: fileMap.size,
    anonymousMs: anonUs / 1000,
    anonymousSharePct: share(anonUs / 1000),
  };
}

/**
 * JS self-time charged to a set of time windows, attributed to one leaf
 * function. The shape `correlateAllocators` (GC) and `buildReflowModel` (forced
 * layout) both surface — what JS was running across some windows of interest.
 */
export interface WindowedSuspect {
  functionName: string;
  url: string;
  line: number;
  /** JS self-time charged inside the windows (ms). */
  selfMs: number;
  /** Share of attributed window JS self-time. */
  sharePct: number;
  app: boolean;
}

/**
 * Charge CPU-profile JS self-time to a set of time windows and rank the leaf
 * functions that ran in them. Given disjoint, time-ordered `[startUs, endUs)`
 * windows, sweep the sample timeline once (same charging rule as
 * `buildProfileModel`) and aggregate self-time per function across all windows.
 *
 * This is the generic engine behind both the GC allocator heuristic
 * (`correlateAllocators`) and forced-layout culprit attribution
 * (`buildReflowModel`): "which function was consistently hot during these
 * windows." Windows must be disjoint — the sweep advances a single pointer and
 * assumes no overlap.
 */
export function attributeWindowedSelfTime(
  profiles: RawProfile[],
  windows: Array<{ startUs: number; endUs: number }>,
  options: { warmupEndUs?: number; mainPid?: number; top?: number } = {},
): WindowedSuspect[] {
  const main = pickMainProfile(profiles, options.mainPid);
  if (!main) return [];
  const warmupEndUs = options.warmupEndUs ?? 0;
  const wins = windows
    .filter((w) => w.endUs > w.startUs && w.endUs > warmupEndUs)
    .sort((a, b) => a.startUs - b.startUs);
  if (wins.length === 0) return [];

  const { tsArr, order } = buildTimeline(main);
  const memo = new Map<number, Target>();
  const selfUs = new Map<string, WindowedSuspect>();
  let totalUs = 0;
  let wi = 0;

  for (let k = 0; k < order.length; k++) {
    const i = order[k] ?? 0;
    const tStart = tsArr[i] ?? 0;
    const tNext = k + 1 < order.length ? (tsArr[order[k + 1] ?? 0] ?? tStart) : tStart;
    const dt = Math.max(0, tNext - tStart);
    if (dt === 0) continue;
    // Advance past windows that already ended at or before this sample.
    while (wi < wins.length && (wins[wi]?.endUs ?? 0) <= tStart) wi++;
    if (wi >= wins.length) break;
    // Sample sits in a gap before the next window — skip without advancing.
    if (tStart < (wins[wi]?.startUs ?? 0)) continue;

    const target = resolveTarget(main, main.samples[i] ?? -1, memo);
    if (target.kind !== 'js') continue;
    totalUs += dt;
    const existing = selfUs.get(target.key);
    if (existing) {
      existing.selfMs += dt / 1000;
    } else {
      selfUs.set(target.key, {
        functionName: target.fn,
        url: target.url,
        line: target.line,
        selfMs: dt / 1000,
        sharePct: 0,
        app: target.app,
      });
    }
  }

  const totalMs = totalUs / 1000;
  const keyOf = (f: WindowedSuspect) => `${f.functionName}@${f.url}:${f.line}`;
  return [...selfUs.values()]
    .map((f) => ({ ...f, sharePct: totalMs > 0 ? (f.selfMs / totalMs) * 100 : 0 }))
    .sort((a, b) => b.selfMs - a.selfMs || (keyOf(a) < keyOf(b) ? -1 : 1))
    .slice(0, options.top ?? 10);
}

export interface AllocatorSuspect {
  functionName: string;
  url: string;
  line: number;
  /** JS self-time charged inside the pre-GC windows (ms). */
  preGcMs: number;
  /** Share of attributed pre-GC JS self-time. */
  sharePct: number;
  app: boolean;
}

/**
 * Heuristic allocation attribution. Given the mutator windows that filled the
 * nursery before each scavenge (`[startUs, endUs)`, disjoint and time-ordered),
 * charge JS self-time to the leaf function running in each. Aggregated across
 * windows, the function consistently hot just before GC is the likely heavy
 * allocator.
 *
 * This is a correlation, not proof: a scavenge fires on whichever allocation
 * crosses the new-space limit, not necessarily the biggest allocator. Treat the
 * result as a lead and confirm with a sampling heap profiler when it matters.
 *
 * A thin wrapper over `attributeWindowedSelfTime` (the shared engine), renaming
 * `selfMs → preGcMs` for this caller's vocabulary; numbers are identical.
 */
export function correlateAllocators(
  profiles: RawProfile[],
  windows: Array<{ startUs: number; endUs: number }>,
  options: { warmupEndUs?: number; mainPid?: number; top?: number } = {},
): AllocatorSuspect[] {
  return attributeWindowedSelfTime(profiles, windows, options).map((s) => ({
    functionName: s.functionName,
    url: s.url,
    line: s.line,
    preGcMs: s.selfMs,
    sharePct: s.sharePct,
    app: s.app,
  }));
}

/** CPU-profile self-time charged to one task-sized time window. */
export interface WindowProfile {
  /** JS self-time inside the window (ms). */
  jsMs: number;
  /** Engine/native (incl. console-instrumentation) self-time (ms). */
  nativeMs: number;
  gcMs: number;
  idleMs: number;
  /** Hottest JS functions inside the window, biggest self-time first. */
  top: HotFunction[];
}

/**
 * Attribute CPU-profile self-time to a set of disjoint time windows — one per
 * long task — in a single sweep of the sample timeline. Same charging rule as
 * `buildProfileModel` (each non-negative inter-sample gap goes to the sample
 * running during it), but bucketed per window so each long task can name the
 * function it actually spent its time in. Returns one `WindowProfile` per input
 * window, in input order (empty when there is no profile or no samples land in
 * the window).
 */
export function attributeWindows(
  profiles: RawProfile[],
  windows: ReadonlyArray<{ startUs: number; endUs: number }>,
  options: { mainPid?: number; top?: number } = {},
): WindowProfile[] {
  const empty = (): WindowProfile => ({
    jsMs: 0,
    nativeMs: 0,
    gcMs: 0,
    idleMs: 0,
    top: [],
  });
  const out = windows.map(empty);
  const main = pickMainProfile(profiles, options.mainPid);
  if (!main || windows.length === 0) return out;

  const { tsArr, order } = buildTimeline(main);
  const memo = new Map<number, Target>();
  const accs = windows.map(() => ({
    js: 0,
    native: 0,
    gc: 0,
    idle: 0,
    fns: new Map<string, HotFunction>(),
  }));

  // Visit windows in start order with a moving pointer; long tasks are top-level
  // and never overlap, so each sample falls in at most one window.
  const idx = windows
    .map((_, i) => i)
    .sort((a, b) => windows[a]!.startUs - windows[b]!.startUs);
  let wp = 0;

  for (let k = 0; k < order.length; k++) {
    const i = order[k] ?? 0;
    const tStart = tsArr[i] ?? 0;
    const tNext = k + 1 < order.length ? (tsArr[order[k + 1] ?? 0] ?? tStart) : tStart;
    const dt = Math.max(0, tNext - tStart);
    if (dt === 0) continue;
    while (wp < idx.length && (windows[idx[wp]!]?.endUs ?? 0) <= tStart) wp++;
    if (wp >= idx.length) break;
    const w = idx[wp]!;
    if (tStart < (windows[w]?.startUs ?? 0)) continue; // in a gap before the next window
    const acc = accs[w]!;

    const target = resolveTarget(main, main.samples[i] ?? -1, memo);
    switch (target.kind) {
      case 'idle':
        acc.idle += dt;
        break;
      case 'gc':
        acc.gc += dt;
        break;
      case 'native':
        acc.native += dt;
        break;
      case 'js': {
        acc.js += dt;
        const existing = acc.fns.get(target.key);
        if (existing) {
          existing.selfMs += dt / 1000;
        } else {
          acc.fns.set(target.key, {
            functionName: target.fn,
            url: target.url,
            line: target.line,
            col: target.col,
            selfMs: dt / 1000,
            sharePct: 0,
            app: target.app,
          });
        }
        break;
      }
    }
  }

  const topN = options.top ?? 3;
  const keyOf = (f: HotFunction) => `${f.functionName}@${f.url}:${f.line}`;
  windows.forEach((_, i) => {
    const acc = accs[i]!;
    const jsMs = acc.js / 1000;
    const top = [...acc.fns.values()]
      .map((f) => ({ ...f, sharePct: jsMs > 0 ? (f.selfMs / jsMs) * 100 : 0 }))
      .sort((a, b) => b.selfMs - a.selfMs || (keyOf(a) < keyOf(b) ? -1 : 1))
      .slice(0, topN);
    out[i] = {
      jsMs,
      nativeMs: acc.native / 1000,
      gcMs: acc.gc / 1000,
      idleMs: acc.idle / 1000,
      top,
    };
  });
  return out;
}
