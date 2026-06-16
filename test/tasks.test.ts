import { describe, expect, it } from 'vitest';
import { blockingTask, buildTaskModel, isTaskEvent } from '../src/tasks.ts';
import type { TraceEvent } from '../src/trace-events.ts';

function runTask(ts: number, durUs: number, pid = 1, tid = 1): TraceEvent {
  return { name: 'RunTask', ph: 'X', ts, dur: durUs, pid, tid, cat: 'devtools.timeline' };
}

describe('isTaskEvent', () => {
  it('matches complete RunTask events only', () => {
    expect(isTaskEvent(runTask(0, 1000))).toBe(true);
    expect(isTaskEvent({ name: 'RunTask', ph: 'B', ts: 0 })).toBe(false);
    expect(isTaskEvent({ name: 'FunctionCall', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildTaskModel', () => {
  it('keeps only long tasks on the busiest thread, relative to the origin', () => {
    const events = [
      runTask(1_000, 60_000), // 60ms long task at +0ms (origin 1000)
      runTask(200_000, 90_000), // 90ms long task
      runTask(300_000, 5_000), // 5ms — below threshold
      runTask(400_000, 80_000, 1, 99), // long, but a different (quiet) thread
    ];
    const m = buildTaskModel(events, { originUs: 1_000, mainPid: 1, longTaskMs: 50 });
    expect(m.mainTid).toBe(1); // tid 1 has the most total task time
    expect(m.longTaskCount).toBe(2);
    expect(m.longTasks[0]?.durMs).toBe(90); // sorted by duration desc
    expect(m.longTasks[1]?.durMs).toBe(60);
    expect(m.longTasks[1]?.startMs).toBe(0); // (1000 - 1000)/1000
    expect(m.totalLongTaskMs).toBe(150);
  });

  it('excludes warmup tasks', () => {
    const m = buildTaskModel([runTask(1_000, 60_000)], {
      originUs: 1_000,
      warmupEndUs: 2_000,
      longTaskMs: 50,
    });
    expect(m.longTaskCount).toBe(0);
  });

  it('ignores other processes', () => {
    const m = buildTaskModel([runTask(1_000, 60_000, 777)], {
      originUs: 1_000,
      mainPid: 1,
      longTaskMs: 50,
    });
    expect(m.longTaskCount).toBe(0);
  });
});

describe('blockingTask', () => {
  const tasks = [
    { startMs: 100, durMs: 90 }, // 100–190ms
    { startMs: 500, durMs: 60 }, // 500–560ms
  ];

  it('finds the long task overlapping a window (blocked gap)', () => {
    expect(blockingTask(tasks, 120, 250)?.durMs).toBe(90);
  });

  it('returns null for a window with no overlapping long task (idle gap)', () => {
    expect(blockingTask(tasks, 300, 450)).toBeNull();
  });
});
