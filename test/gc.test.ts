import { describe, expect, it } from 'vitest';
import { buildGcModel, isGcEvent } from '../src/gc.ts';
import { ProfileCollector } from '../src/profile.ts';
import type { TraceEvent } from '../src/trace-events.ts';

function gc(
  name: 'MinorGC' | 'MajorGC',
  ts: number,
  durUs: number,
  before: number,
  after: number,
  pid = 1,
  tid = 1,
): TraceEvent {
  return {
    name,
    ph: 'X',
    ts,
    dur: durUs,
    pid,
    tid,
    cat: 'devtools.timeline,disabled-by-default-v8.gc',
    args: { usedHeapSizeBefore: before, usedHeapSizeAfter: after },
  };
}

// A profile whose only JS leaf (node 2 = allocHot) runs across the whole
// window, so the pre-scavenge correlation must surface it.
function profileEvents(pid = 1): TraceEvent[] {
  const PROF_CAT = 'disabled-by-default-v8.cpu_profiler';
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', codeType: 'other' } },
    {
      id: 2,
      parent: 1,
      callFrame: {
        functionName: 'allocHot',
        url: 'http://localhost/src/loop.ts',
        lineNumber: 41,
        columnNumber: 0,
        codeType: 'JS',
      },
    },
  ];
  // Samples every 1ms from t=1000 to t=20000 — all on allocHot.
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (let t = 1000; t <= 20_000; t += 1000) {
    samples.push(2);
    timeDeltas.push(1000);
  }
  return [
    {
      name: 'Profile',
      ph: 'P',
      ts: 1000,
      id: '0x1',
      pid,
      tid: 1,
      cat: PROF_CAT,
      args: { data: { startTime: 1000 } },
    },
    {
      name: 'ProfileChunk',
      ph: 'P',
      ts: 1000,
      id: '0x1',
      pid,
      cat: PROF_CAT,
      args: { data: { cpuProfile: { nodes, samples }, timeDeltas } },
    },
  ];
}

describe('isGcEvent', () => {
  it('matches complete MinorGC/MajorGC events only', () => {
    expect(isGcEvent(gc('MinorGC', 0, 1000, 10, 5))).toBe(true);
    expect(isGcEvent(gc('MajorGC', 0, 1000, 10, 5))).toBe(true);
    expect(isGcEvent({ name: 'MinorGC', ph: 'B', ts: 0 })).toBe(false);
    expect(isGcEvent({ name: 'V8.GCScavenger', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildGcModel', () => {
  const events = [
    gc('MinorGC', 5_000, 2_000, 100, 70), // 2ms, 30 bytes freed
    gc('MinorGC', 10_000, 3_000, 120, 80), // 3ms, 40 bytes freed
    gc('MajorGC', 15_000, 8_000, 200, 150), // 8ms, 50 bytes freed
  ];

  it('summarizes scavenge vs mark-compact pauses and bytes freed', () => {
    const m = buildGcModel(events, [], { originUs: 5_000, mainPid: 1 })!;
    expect(m).not.toBeNull();
    expect(m.scavengeCount).toBe(2);
    expect(m.scavengeMs).toBeCloseTo(5, 5); // 2 + 3
    expect(m.markCompactCount).toBe(1);
    expect(m.markCompactMs).toBeCloseTo(8, 5);
    expect(m.totalGcMs).toBeCloseTo(13, 5);
    expect(m.youngFreedBytes).toBe(70); // scavenges only: 30 + 40
    expect(m.pauses[0]?.durMs).toBe(8); // longest first
    expect(m.pauses[0]?.kind).toBe('mark-compact');
    expect(m.pauses[0]?.startMs).toBe(10); // (15000 - 5000)/1000
  });

  it('returns null without GC events', () => {
    expect(buildGcModel([], [], { originUs: 0 })).toBeNull();
  });

  it('excludes warmup GC and ignores other processes', () => {
    const m = buildGcModel(events, [], { originUs: 0, mainPid: 1, warmupEndUs: 6_000 })!;
    expect(m.scavengeCount).toBe(1); // the t=5000 scavenge is in warmup
    expect(
      buildGcModel([gc('MinorGC', 5_000, 2_000, 100, 70, 777)], [], {
        originUs: 0,
        mainPid: 1,
      }),
    ).toBeNull();
  });

  it('correlates the JS running before scavenges as a suspected allocator', () => {
    const collector = new ProfileCollector();
    for (const e of profileEvents()) collector.add(e);
    const m = buildGcModel(events, collector.list(), { originUs: 0, mainPid: 1 })!;
    expect(m.suspectedAllocators[0]?.functionName).toBe('allocHot');
    expect(m.suspectedAllocators[0]?.app).toBe(true);
    expect(m.suspectedAllocators[0]?.preGcMs).toBeGreaterThan(0);
    // Mark-compact (MajorGC) windows are not correlated, only scavenges.
    expect(m.suspectedAllocators[0]?.sharePct).toBeCloseTo(100, 1);
  });
});
