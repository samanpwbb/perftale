import { buildFrameModel, isFrameEvent, type FrameModel } from './frames.ts';
import { Reducer, type ReductionStats } from './reduce.ts';
import { streamTraceEvents } from './stream.ts';
import type { TraceEvent } from './trace-events.ts';

export interface Analysis {
  reduction: ReductionStats;
  frames: FrameModel;
}

export interface AnalyzeOptions {
  fps?: number;
}

/**
 * One streaming pass over the trace: count the noise reduction and buffer the
 * (tiny) frame-event subset, then build the frame model. Adding more models in
 * later steps means buffering their event subsets in this same loop.
 */
export async function analyzeTrace(
  filePath: string,
  options: AnalyzeOptions = {},
): Promise<Analysis> {
  const reducer = new Reducer();
  const frameEvents: TraceEvent[] = [];

  for await (const event of streamTraceEvents(filePath)) {
    const kept = reducer.add(event);
    if (kept && isFrameEvent(event)) frameEvents.push(event);
  }

  return {
    reduction: reducer.finish(),
    frames: buildFrameModel(frameEvents, {
      ...(options.fps ? { fps: options.fps } : {}),
    }),
  };
}
