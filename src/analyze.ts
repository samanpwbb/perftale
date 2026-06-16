import { buildFrameModel, isFrameEvent, type FrameModel } from './frames.ts';
import { buildGcModel, isGcEvent, type GcModel } from './gc.ts';
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
import { buildVerdict, type Verdict } from './verdict.ts';

export interface Analysis {
  /** The conclusions, derived from the models below. */
  verdict: Verdict;
  frames: FrameModel;
  profile: ProfileModel | null;
  tasks: TaskModel;
  /** GC pressure + heuristic allocation attribution (null without v8.gc data). */
  gc: GcModel | null;
  reduction: ReductionStats;
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
  const gcEvents: TraceEvent[] = [];
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
    } else if (isGcEvent(event)) {
      gcEvents.push(event);
    }
  }

  const warmup = warmupEndUs > 0 ? { warmupEndUs } : {};
  const pid = mainPid !== undefined ? { mainPid } : {};
  const originUs = Number.isFinite(frameOriginUs) ? frameOriginUs : 0;

  const frames = buildFrameModel(frameEvents, {
    ...(options.fps ? { fps: options.fps } : {}),
    ...warmup,
  });
  const profile = buildProfileModel(profiles.list(), { ...warmup, ...pid });
  const tasks = buildTaskModel(taskEvents, { originUs, ...warmup, ...pid });
  const gc = buildGcModel(gcEvents, profiles.list(), { originUs, ...warmup, ...pid });

  return {
    verdict: buildVerdict(frames, profile, tasks, gc),
    frames,
    profile,
    tasks,
    gc,
    reduction: reducer.finish(),
  };
}
