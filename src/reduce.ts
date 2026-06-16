import { classifyNoise, type DropReason } from './filter.ts';
import { streamTraceEvents } from './stream.ts';
import type { TraceEvent } from './trace-events.ts';

/** Deterministic summary of a single streaming pass over a trace. */
export interface ReductionStats {
  /** Total events seen in the traceEvents array. */
  total: number;
  /** Events kept as signal. */
  kept: number;
  /** Events dropped as noise. */
  dropped: number;
  /** Drop counts by reason. */
  droppedByReason: Record<DropReason, number>;
  /** Kept-event counts by category, highest first. */
  keptByCategory: { cat: string; count: number }[];
  /** Wall-clock span of kept timeline events, in milliseconds. */
  timeSpanMs: number | null;
}

/**
 * Accumulates noise-vs-signal counts as events stream past. Pulled out of
 * `scanTrace` so the full `analyze` pass can reuse it without a second read of
 * the trace.
 */
export class Reducer {
  private total = 0;
  private kept = 0;
  private readonly droppedByReason: Record<DropReason, number> = {
    inspector: 0,
    metadata: 0,
    'source-rundown': 0,
  };
  private readonly keptCats = new Map<string, number>();
  private tsMin = Infinity;
  private tsMax = -Infinity;

  /** Feed one event. Returns true when the event is signal (kept). */
  add(event: TraceEvent): boolean {
    this.total++;
    const reason = classifyNoise(event);
    if (reason !== null) {
      this.droppedByReason[reason]++;
      return false;
    }
    this.kept++;

    const cat = event.cat ?? '';
    this.keptCats.set(cat, (this.keptCats.get(cat) ?? 0) + 1);

    const { ts, ph } = event;
    if (typeof ts === 'number' && (ph === 'X' || ph === 'B' || ph === 'I')) {
      if (ts < this.tsMin) this.tsMin = ts;
      if (ts > this.tsMax) this.tsMax = ts;
    }
    return true;
  }

  finish(topCategories = 25): ReductionStats {
    const keptByCategory = [...this.keptCats.entries()]
      .map(([cat, count]) => ({ cat, count }))
      // count desc, then category asc — fully deterministic ordering
      .sort((a, b) => b.count - a.count || (a.cat < b.cat ? -1 : 1))
      .slice(0, topCategories);

    return {
      total: this.total,
      kept: this.kept,
      dropped: this.total - this.kept,
      droppedByReason: { ...this.droppedByReason },
      keptByCategory,
      timeSpanMs: this.tsMin <= this.tsMax ? (this.tsMax - this.tsMin) / 1000 : null,
    };
  }
}

/**
 * Stream a trace once, applying the noise filter, and report what was kept vs
 * dropped. On its own it demonstrates the size collapse on large traces.
 */
export async function scanTrace(
  filePath: string,
  topCategories = 25,
): Promise<ReductionStats> {
  const reducer = new Reducer();
  for await (const event of streamTraceEvents(filePath)) reducer.add(event);
  return reducer.finish(topCategories);
}
