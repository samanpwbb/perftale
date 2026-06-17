import type { Analysis } from './analyze.ts';
import type { Summary } from './summary-schema.ts';

// The output artifact's type lives in a dedicated declaration module
// (src/summary-schema.ts). Re-export it so importers of './summary.ts' still resolve it.
export type { Summary } from './summary-schema.ts';

/** Bump when the summary shape changes in a way that invalidates saved artifacts. */
export const SUMMARY_SCHEMA_VERSION = 6;

export function buildSummary(trace: string, analysis: Analysis): Summary {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    trace,
    verdict: analysis.verdict,
    frames: analysis.frames,
    profile: analysis.profile,
    tasks: analysis.tasks,
    reflow: analysis.reflow,
    gc: analysis.gc,
    react: analysis.react,
    size: analysis.reduction,
  };
}

/** Stable, pretty JSON with a trailing newline. */
export function serializeSummary(summary: Summary): string {
  return JSON.stringify(summary, null, 2) + '\n';
}
