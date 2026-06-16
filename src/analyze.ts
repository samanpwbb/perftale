import { buildFrameModel, isFrameEvent, type FrameModel } from './frames.ts';
import {
  ProfileCollector,
  buildProfileModel,
  isProfileEvent,
  type ProfileModel,
} from './profile.ts';
import { Reducer, type ReductionStats } from './reduce.ts';
import { streamTraceEvents } from './stream.ts';
import { buildTaskModel, isTaskEvent, type TaskModel } from './tasks.ts';
import type { TraceEvent } from './trace-events.ts';

export interface Analysis {
  reduction: ReductionStats;
  frames: FrameModel;
  profile: ProfileModel | null;
  tasks: TaskModel;
}

/** Frame events that establish the frame model's time origin (excludes PipelineReporter). */
const ORIGIN_EVENT_NAMES = new Set([
  'BeginFrame',
  'DrawFrame',
  'DroppedFrame',
  'SendBeginMainFrameToCommit',
]);

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
  const taskEvents: TraceEvent[] = [];
  const profiles = new ProfileCollector();
  // The renderer process id, taken from the frame events, so JS attribution
  // selects the app's profile rather than a browser-extension one.
  let mainPid: number | undefined;
  // Frame model's time origin, replicated here so the task model can share it.
  let frameOriginUs = Infinity;
  // End of the profiling-overhead warmup: the main thread is stalled while the
  // CPU profiler starts up, which drops every frame at the recording's start.
  // That is a capture artifact, not app jank, so we exclude it from analysis.
  let warmupEndUs = 0;

  for await (const event of streamTraceEvents(filePath)) {
    const kept = reducer.add(event);
    if (!kept) continue;
    if (event.name === 'CpuProfiler::StartProfiling' && typeof event.dur === 'number') {
      warmupEndUs = Math.max(warmupEndUs, event.ts + event.dur);
    }
    if (isFrameEvent(event)) {
      frameEvents.push(event);
      if (mainPid === undefined && typeof event.pid === 'number') mainPid = event.pid;
      if (ORIGIN_EVENT_NAMES.has(event.name ?? '') && event.ts < frameOriginUs) {
        frameOriginUs = event.ts;
      }
    } else if (isTaskEvent(event)) {
      taskEvents.push(event);
    } else if (isProfileEvent(event)) {
      profiles.add(event);
    }
  }

  const warmup = warmupEndUs > 0 ? { warmupEndUs } : {};
  const pid = mainPid !== undefined ? { mainPid } : {};
  const originUs = Number.isFinite(frameOriginUs) ? frameOriginUs : 0;
  return {
    reduction: reducer.finish(),
    frames: buildFrameModel(frameEvents, {
      ...(options.fps ? { fps: options.fps } : {}),
      ...warmup,
    }),
    profile: buildProfileModel(profiles.list(), { ...warmup, ...pid }),
    tasks: buildTaskModel(taskEvents, { originUs, ...warmup, ...pid }),
  };
}
