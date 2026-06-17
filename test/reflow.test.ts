import { describe, expect, it } from 'vitest';
import { ProfileCollector } from '../src/profile.ts';
import { buildReflowModel, isReflowStackEvent } from '../src/reflow.ts';
import type { TraceEvent } from '../src/trace-events.ts';

function fc(ts: number, durUs: number, pid = 1, tid = 1): TraceEvent {
  return {
    name: 'FunctionCall',
    ph: 'X',
    ts,
    dur: durUs,
    pid,
    tid,
    cat: 'devtools.timeline',
  };
}
function layout(
  name: 'Layout' | 'UpdateLayoutTree',
  ts: number,
  durUs: number,
  pid = 1,
  tid = 1,
): TraceEvent {
  return { name, ph: 'X', ts, dur: durUs, pid, tid, cat: 'devtools.timeline' };
}

const OPTS = { originUs: 0, mainPid: 1, mainTid: 1 };

// A profile whose only JS leaf (node 2 = forcedReader) runs from t=2000 onward,
// so the run-up window before a forced layout must surface it as the culprit.
function profileEvents(pid = 1): TraceEvent[] {
  const PROF_CAT = 'disabled-by-default-v8.cpu_profiler';
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', codeType: 'other' } },
    {
      id: 2,
      parent: 1,
      callFrame: {
        functionName: 'forcedReader',
        url: 'http://localhost/src/grid.ts',
        lineNumber: 87,
        columnNumber: 0,
        codeType: 'JS',
      },
    },
  ];
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

describe('isReflowStackEvent', () => {
  it('matches the FunctionCall/Layout/UpdateLayoutTree X events only', () => {
    expect(isReflowStackEvent(fc(0, 1))).toBe(true);
    expect(isReflowStackEvent(layout('Layout', 0, 1))).toBe(true);
    expect(isReflowStackEvent(layout('UpdateLayoutTree', 0, 1))).toBe(true);
    expect(isReflowStackEvent({ name: 'Layout', ph: 'B', ts: 0 })).toBe(false);
    expect(isReflowStackEvent({ name: 'RunTask', ph: 'X', ts: 0 })).toBe(false);
    expect(isReflowStackEvent({ name: 'Paint', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildReflowModel', () => {
  it('flags a Layout nested inside a FunctionCall as forced', () => {
    const m = buildReflowModel([fc(1000, 4000), layout('Layout', 2000, 200)], [], OPTS)!;
    expect(m).not.toBeNull();
    expect(m.forcedLayoutCount).toBe(1);
    expect(m.forcedStyleCount).toBe(0);
    expect(m.forcedMs).toBeCloseTo(0.2, 5);
    expect(m.worstMs).toBeCloseTo(0.2, 5);
    expect(m.worstBurstCount).toBe(1);
    expect(m.occurrences[0]).toMatchObject({ kind: 'layout', startMs: 2, durMs: 0.2 });
  });

  it('flags a forced UpdateLayoutTree as a style recalc', () => {
    const m = buildReflowModel(
      [fc(1000, 4000), layout('UpdateLayoutTree', 2000, 150)],
      [],
      OPTS,
    )!;
    expect(m.forcedStyleCount).toBe(1);
    expect(m.forcedLayoutCount).toBe(0);
    expect(m.occurrences[0]?.kind).toBe('style');
  });

  it('counts the worst read/write burst — forced layouts sharing one call', () => {
    const m = buildReflowModel(
      [
        fc(1000, 4000),
        layout('Layout', 2000, 100),
        layout('UpdateLayoutTree', 2500, 100),
        layout('Layout', 3000, 100),
      ],
      [],
      OPTS,
    )!;
    expect(m.forcedLayoutCount).toBe(2);
    expect(m.forcedStyleCount).toBe(1);
    expect(m.worstBurstCount).toBe(3);
  });

  it('returns null when a layout is not contained by any FunctionCall', () => {
    // Lone scheduled layout (would sit directly under RunTask) — not forced.
    expect(buildReflowModel([layout('Layout', 2000, 100)], [], OPTS)).toBeNull();
    // FunctionCall ends before the layout starts — no containment.
    expect(
      buildReflowModel([fc(1000, 500), layout('Layout', 2000, 100)], [], OPTS),
    ).toBeNull();
  });

  it('returns null without any layout events', () => {
    expect(buildReflowModel([], [], { originUs: 0 })).toBeNull();
    expect(buildReflowModel([fc(1000, 4000)], [], OPTS)).toBeNull();
  });

  it('excludes warmup-era layout and ignores other processes', () => {
    const evs = [fc(1000, 4000), layout('Layout', 2000, 100)];
    // The only forced layout starts inside warmup → nothing left → null.
    expect(buildReflowModel(evs, [], { ...OPTS, warmupEndUs: 3000 })).toBeNull();
    // Same events on a foreign pid are filtered out.
    expect(
      buildReflowModel([fc(1000, 4000, 777), layout('Layout', 2000, 100, 777)], [], OPTS),
    ).toBeNull();
  });

  it('attributes the JS running in the run-up as the forced-layout culprit', () => {
    const collector = new ProfileCollector();
    for (const e of profileEvents()) collector.add(e);
    const m = buildReflowModel(
      [fc(1000, 30_000), layout('Layout', 25_000, 200)],
      collector.list(),
      OPTS,
    )!;
    expect(m.culprits[0]?.functionName).toBe('forcedReader');
    expect(m.culprits[0]?.app).toBe(true);
    expect(m.culprits[0]?.selfMs).toBeGreaterThan(0);
    expect(m.culprits[0]?.sharePct).toBeCloseTo(100, 1);
  });
});
