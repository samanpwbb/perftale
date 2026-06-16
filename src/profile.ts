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
 */

export interface CallFrame {
  functionName?: string | undefined;
  url?: string | undefined;
  lineNumber?: number | undefined;
  columnNumber?: number | undefined;
  codeType?: string | undefined;
}

interface RawProfile {
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
}

export interface ProfileModelOptions {
  warmupEndUs?: number;
  topFunctions?: number;
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

/** Dependency code rather than first-party source. */
function isAppCode(url: string): boolean {
  return url !== '' && !/node_modules|\/\.vite\/|\/deps\//.test(url);
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
    const name = frame.functionName || '(anonymous)';
    target = {
      kind: 'js',
      key: `${name}@${url}:${line}`,
      fn: name,
      url,
      line,
      col,
      app: isAppCode(url),
    };
  } else {
    target = NATIVE_TARGET;
  }

  memo.set(nodeId, target);
  return target;
}

/**
 * Build the JS-attribution model from the collected profiles. Picks the
 * busiest thread (the renderer main thread) and ranks functions by self-time.
 */
export function buildProfileModel(
  profiles: RawProfile[],
  options: ProfileModelOptions = {},
): ProfileModel | null {
  if (profiles.length === 0) return null;

  // Prefer profiles from the renderer process (where the frames came from), so
  // a busy browser-extension profile can't win.
  const sameProcess = profiles.filter((p) => p.pid === options.mainPid);
  const candidates =
    options.mainPid !== undefined && sameProcess.length > 0 ? sameProcess : profiles;

  // Among those, pick the thread with the most *working* (non-idle) time.
  const activeTime = (p: RawProfile): number => {
    let sum = 0;
    const n = Math.min(p.samples.length, p.deltas.length);
    for (let i = 0; i < n; i++) {
      const fn = p.frames.get(p.samples[i] ?? -1)?.functionName ?? '';
      if (fn !== '(idle)') sum += p.deltas[i] ?? 0;
    }
    return sum;
  };
  let main = candidates[0]!;
  let mainActive = activeTime(main);
  for (const p of candidates.slice(1)) {
    const a = activeTime(p);
    if (a > mainActive) {
      main = p;
      mainActive = a;
    }
  }

  const warmupEndUs = options.warmupEndUs ?? 0;
  const analysisStartUs = Math.max(warmupEndUs, main.startUs);

  const memo = new Map<number, Target>();
  const selfUs = new Map<string, HotFunction>();
  let idleUs = 0;
  let gcUs = 0;
  let nativeUs = 0;
  let jsUs = 0;
  let sampleCount = 0;

  // V8 emits some slightly out-of-order samples (negative deltas). Reconstruct
  // absolute timestamps, sort samples by time, then charge each non-negative
  // inter-sample gap to the sample running during it. This nets out the
  // disorder instead of letting negatives subtract from a function's total.
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
          existing.selfMs += dt / 1000;
        } else {
          selfUs.set(target.key, {
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

  const jsMs = jsUs / 1000;
  const keyOf = (f: HotFunction) => `${f.functionName}@${f.url}:${f.line}`;
  const functions = [...selfUs.values()]
    .map((f) => ({ ...f, sharePct: jsMs > 0 ? (f.selfMs / jsMs) * 100 : 0 }))
    .sort((a, b) => b.selfMs - a.selfMs || (keyOf(a) < keyOf(b) ? -1 : 1))
    .slice(0, options.topFunctions ?? 25);

  return {
    tid: main.tid,
    sampleCount,
    activeMs: (gcUs + nativeUs + jsUs) / 1000,
    idleMs: idleUs / 1000,
    gcMs: gcUs / 1000,
    nativeMs: nativeUs / 1000,
    jsMs,
    functions,
  };
}
