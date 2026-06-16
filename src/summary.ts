import type { Analysis } from './analyze.ts';
import type { FrameModel } from './frames.ts';
import type { ProfileModel } from './profile.ts';
import type { ReductionStats } from './reduce.ts';
import type { TaskModel } from './tasks.ts';

/** Bump when the summary shape changes in a way that invalidates saved artifacts. */
export const SUMMARY_SCHEMA_VERSION = 1;

/**
 * The persisted artifact. Deliberately free of wall-clock timestamps so saved
 * summaries are byte-stable and diffable across runs.
 */
export interface Summary {
  schemaVersion: number;
  trace: string;
  frames: FrameModel;
  profile: ProfileModel | null;
  tasks: TaskModel;
  size: ReductionStats;
}

export function buildSummary(trace: string, analysis: Analysis): Summary {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    trace,
    frames: analysis.frames,
    profile: analysis.profile,
    tasks: analysis.tasks,
    size: analysis.reduction,
  };
}

/** Stable, pretty JSON with a trailing newline. */
export function serializeSummary(summary: Summary): string {
  return JSON.stringify(summary, null, 2) + '\n';
}
