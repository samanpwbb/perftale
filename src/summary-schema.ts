/**
 * Output format — the canonical shape of the persisted summary artifact.
 *
 * `analyze --json` (or `--out <path>`) writes this object to
 * `.perftale/<trace>.summary.json`. It's the contract an agent reads to find and
 * fix jank, so the whole shape is declared here in one place rather than scattered
 * across the model modules. The individual model interfaces still live next to the
 * code that builds them; this file re-exports them so the entire artifact type is
 * importable from a single module.
 *
 * The artifact is deliberately free of wall-clock timestamps so saved summaries are
 * byte-stable and diffable across runs. `schemaVersion` carries
 * `SUMMARY_SCHEMA_VERSION` (see `summary.ts`) — bump it when this shape changes in a
 * way that invalidates saved artifacts.
 */
import type { FrameModel } from './frames.ts';
import type { GcModel } from './gc.ts';
import type { ProfileModel } from './profile.ts';
import type { ReactModel } from './react.ts';
import type { ReductionStats } from './reduce.ts';
import type { ReflowModel } from './reflow.ts';
import type { TaskModel } from './tasks.ts';
import type { Verdict } from './verdict.ts';

/** The persisted `.perftale/<trace>.summary.json` artifact. */
export interface Summary {
  /** Artifact schema version (SUMMARY_SCHEMA_VERSION); bumps on any shape change. */
  schemaVersion: number;
  /** Source trace filename. */
  trace: string;
  /** The conclusion: headline, what the frame is bound by, top hotspot, caveats. */
  verdict: Verdict;
  /** Refresh rate, dropped frames, freezes, and where main-thread frame time goes. */
  frames: FrameModel;
  /** JS self-time hotspots by function; null when the trace carries no CPU profile. */
  profile: ProfileModel | null;
  /** Long main-thread tasks (>50ms by default). */
  tasks: TaskModel;
  /** Forced synchronous layout (thrashing) + run-up culprits; null when none is forced. */
  reflow: ReflowModel | null;
  /** GC pause pressure and suspected allocators; null when the trace has no v8.gc data. */
  gc: GcModel | null;
  /** Component-render digest from React DevTools timing; null when absent. */
  react: ReactModel | null;
  /** Noise-reduction stats for the streaming pass. */
  size: ReductionStats;
}

// Re-export every model that appears in the artifact tree, so the complete output
// shape can be imported from this one module.
export type {
  Verdict,
  Bound,
  GapVerdict,
  Hotspot,
  ReflowVerdict,
  GcVerdict,
  ReactVerdict,
} from './verdict.ts';
export type {
  FrameModel,
  RefreshInfo,
  MainThreadPhase,
  DroppedCluster,
} from './frames.ts';
export type { ProfileModel, HotFunction, AllocatorSuspect } from './profile.ts';
export type {
  TaskModel,
  LongTask,
  LongTaskCategories,
  LongTaskHotFunction,
} from './tasks.ts';
export type { GcModel, GcPause } from './gc.ts';
export type { ReflowModel, ReflowCulprit, ForcedLayout } from './reflow.ts';
export type { ReactModel, ReactComponent } from './react.ts';
export type { ReductionStats } from './reduce.ts';
export type { DropReason } from './filter.ts';
