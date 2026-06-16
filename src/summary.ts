import type { Analysis } from './analyze.ts';
import type { FrameModel } from './frames.ts';
import type { GcModel } from './gc.ts';
import type { ProfileModel } from './profile.ts';
import type { ReductionStats } from './reduce.ts';
import type { TaskModel } from './tasks.ts';
import type { Verdict } from './verdict.ts';

/** Bump when the summary shape changes in a way that invalidates saved artifacts. */
export const SUMMARY_SCHEMA_VERSION = 3;

/**
 * The persisted artifact. Deliberately free of wall-clock timestamps so saved
 * summaries are byte-stable and diffable across runs.
 */
export interface Summary {
  schemaVersion: number;
  trace: string;
  verdict: Verdict;
  frames: FrameModel;
  profile: ProfileModel | null;
  tasks: TaskModel;
  gc: GcModel | null;
  size: ReductionStats;
}

export function buildSummary(trace: string, analysis: Analysis): Summary {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    trace,
    verdict: analysis.verdict,
    frames: analysis.frames,
    profile: analysis.profile,
    tasks: analysis.tasks,
    gc: analysis.gc,
    size: analysis.reduction,
  };
}

/** Stable, pretty JSON with a trailing newline. */
export function serializeSummary(summary: Summary): string {
  return JSON.stringify(summary, null, 2) + '\n';
}
