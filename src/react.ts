import type { TraceEvent } from './trace-events.ts';

/**
 * React component attribution from React's own emitted timing — not a heuristic.
 *
 * When a page is profiled with React DevTools attached (the common local-dev
 * case), React/DevTools emit a User Timing measure around every component
 * render: a nestable-async `b`/`e` pair, on `blink.user_timing`, whose name is
 * the component's display name prefixed with a zero-width space (U+200B). The
 * names are produced and versioned by the React team, so this needs no map of
 * private internal function names and nothing to keep in sync with React.
 *
 * From those spans we recover, per component:
 *   - how many times it rendered (the count — frequent re-renders are the most
 *     common React perf problem, and invisible in a flat CPU profile),
 *   - inclusive render time (the component and its subtree), and
 *   - self render time (inclusive minus the nested child-component spans).
 *
 * This requires DevTools to have been recording; a clean production capture
 * (DevTools detached) carries no such measures and yields no model. That's the
 * intended trade-off — this tool is for local-dev investigation.
 */

/** React DevTools prefixes component measure names with a zero-width space. */
const ZERO_WIDTH = '​';

export interface ReactComponent {
  /** Component display name (zero-width prefix stripped). */
  name: string;
  /** Number of render spans measured in the window. */
  count: number;
  /** Self render time: inclusive minus nested child-component spans (ms). */
  selfMs: number;
  /** Inclusive render time, including the component's subtree (ms). */
  totalMs: number;
  /** Share of total component self time. */
  sharePct: number;
}

export interface ReactModel {
  /** Provenance — there is only one source, kept explicit for the artifact. */
  source: 'react-user-timing';
  /** Distinct components measured. */
  componentCount: number;
  /** Total render spans across all components. */
  renderCount: number;
  /** Wall-clock spent in top-level React renders (sum of root spans), ms. */
  totalRenderMs: number;
  /** Components ranked by self render time, biggest first. */
  components: ReactComponent[];
}

export interface ReactModelOptions {
  /** Exclude renders that began during profiling warmup (µs, absolute). */
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' measures. */
  mainPid?: number;
  topComponents?: number;
}

/** True for a React DevTools component render measure (begin/end). */
export function isReactTimingEvent(event: TraceEvent): boolean {
  if (event.ph !== 'b' && event.ph !== 'e') return false;
  if (!(event.cat ?? '').includes('blink.user_timing')) return false;
  return typeof event.name === 'string' && event.name.startsWith(ZERO_WIDTH);
}

/** An open render span on the nesting stack. */
interface OpenSpan {
  name: string;
  startUs: number;
  /** Inclusive time of child spans closed inside this one (ms). */
  childMs: number;
}

/**
 * Build the React model from the buffered component measures, or null when the
 * trace has none (DevTools wasn't recording). Component spans nest — a parent's
 * `b`/`e` brackets its children's — so a stack recovers self vs inclusive time.
 */
export function buildReactModel(
  events: TraceEvent[],
  options: ReactModelOptions = {},
): ReactModel | null {
  const { mainPid } = options;
  const warmupEndUs = options.warmupEndUs ?? 0;

  // Measures live on the renderer main thread; pick the busiest matching thread
  // so a stray measure from elsewhere can't fragment the nesting stack.
  const inProcess =
    mainPid === undefined ? events : events.filter((e) => e.pid === mainPid);
  const pool = inProcess.length > 0 ? inProcess : events;
  const perThread = new Map<number, number>();
  for (const e of pool) {
    if (typeof e.tid === 'number') perThread.set(e.tid, (perThread.get(e.tid) ?? 0) + 1);
  }
  let tid: number | undefined;
  let best = -1;
  for (const [t, n] of perThread) {
    if (n > best) {
      best = n;
      tid = t;
    }
  }
  const thread = pool.filter((e) => e.tid === tid && typeof e.ts === 'number');
  if (thread.length === 0) return null;

  // Stable order by timestamp keeps the emitted parent-before-child nesting on
  // exact ties (Node's sort is stable), so the stack stays balanced.
  const ordered = thread
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)
    .map((x) => x.e);

  const components = new Map<string, ReactComponent>();
  const stack: OpenSpan[] = [];
  let totalRenderMs = 0;
  let renderCount = 0;

  for (const ev of ordered) {
    if (ev.ph === 'b') {
      stack.push({ name: ev.name!.slice(ZERO_WIDTH.length), startUs: ev.ts, childMs: 0 });
      continue;
    }
    // ph === 'e' — close the innermost open span (LIFO; properly nested).
    const span = stack.pop();
    if (!span) continue;
    const durMs = Math.max(0, (ev.ts - span.startUs) / 1000);
    const parent = stack[stack.length - 1];
    if (parent) parent.childMs += durMs;
    // Drop renders that began during warmup (profiler-startup artifact).
    if (span.startUs < warmupEndUs) continue;

    const selfMs = Math.max(0, durMs - span.childMs);
    const existing = components.get(span.name);
    if (existing) {
      existing.count += 1;
      existing.selfMs += selfMs;
      existing.totalMs += durMs;
    } else {
      components.set(span.name, {
        name: span.name,
        count: 1,
        selfMs,
        totalMs: durMs,
        sharePct: 0,
      });
    }
    renderCount += 1;
    // Root spans (nothing left open) measure the wall-clock React render time.
    if (!parent) totalRenderMs += durMs;
  }

  if (components.size === 0) return null;

  const totalSelfMs = [...components.values()].reduce((s, c) => s + c.selfMs, 0);
  const ranked = [...components.values()]
    .map((c) => ({
      ...c,
      sharePct: totalSelfMs > 0 ? (c.selfMs / totalSelfMs) * 100 : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs || (a.name < b.name ? -1 : 1))
    .slice(0, options.topComponents ?? 15);

  return {
    source: 'react-user-timing',
    componentCount: components.size,
    renderCount,
    totalRenderMs,
    components: ranked,
  };
}

/** The component with the most render spans — the re-render hotspot, if any. */
export function mostRerendered(model: ReactModel): ReactComponent | null {
  let top: ReactComponent | null = null;
  for (const c of model.components) {
    if (!top || c.count > top.count) top = c;
  }
  return top;
}
