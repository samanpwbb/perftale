import { describe, expect, it } from 'vitest';
import { ProfileCollector, buildProfileModel, isProfileEvent } from '../src/profile.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const PROF_CAT = 'disabled-by-default-v8.cpu_profiler';

function profileStart(id: string, pid: number, startTime: number): TraceEvent {
  return {
    name: 'Profile',
    ph: 'P',
    ts: startTime,
    id,
    pid,
    tid: 1,
    cat: PROF_CAT,
    args: { data: { startTime } },
  };
}

interface NodeSpec {
  id: number;
  functionName: string;
  url?: string;
  lineNumber?: number;
  parent?: number;
  codeType?: string;
}

function node(spec: NodeSpec) {
  return {
    id: spec.id,
    parent: spec.parent,
    callFrame: {
      functionName: spec.functionName,
      url: spec.url ?? '',
      lineNumber: spec.lineNumber,
      columnNumber: 0,
      codeType: spec.codeType ?? (spec.url ? 'JS' : 'other'),
    },
  };
}

function chunk(
  id: string,
  pid: number,
  nodes: NodeSpec[],
  samples: number[],
  timeDeltas: number[],
): TraceEvent {
  return {
    name: 'ProfileChunk',
    ph: 'P',
    ts: 0,
    id,
    pid,
    cat: PROF_CAT,
    args: { data: { cpuProfile: { nodes: nodes.map(node), samples }, timeDeltas } },
  };
}

const NODES: NodeSpec[] = [
  { id: 1, functionName: '(root)' },
  {
    id: 2,
    functionName: 'appFn',
    url: 'http://localhost/src/app.ts',
    lineNumber: 9,
    parent: 1,
  },
  { id: 3, functionName: '(idle)', parent: 1 },
  {
    id: 4,
    functionName: 'depFn',
    url: 'http://localhost/node_modules/x.js',
    lineNumber: 4,
    parent: 1,
  },
  { id: 5, functionName: '(garbage collector)', parent: 1 },
];

function model(events: TraceEvent[], opts = {}) {
  const c = new ProfileCollector();
  for (const e of events) c.add(e);
  return buildProfileModel(c.list(), opts);
}

describe('isProfileEvent', () => {
  it('matches Profile/ProfileChunk sample-phase events only', () => {
    expect(isProfileEvent(profileStart('0x2', 1, 0))).toBe(true);
    expect(isProfileEvent({ name: 'RunTask', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildProfileModel', () => {
  // samples sweep app,app,dep,gc,idle,root; each gap is 100µs
  const events = [
    profileStart('0x2', 100, 1000),
    chunk('0x2', 100, NODES, [2, 2, 4, 5, 3, 1], [10, 100, 100, 100, 100, 100]),
  ];

  it('attributes self-time to leaf functions with source', () => {
    const m = model(events);
    expect(m).not.toBeNull();
    const fns = m!.functions;
    expect(fns[0]?.functionName).toBe('appFn');
    expect(fns[0]?.selfMs).toBeCloseTo(0.2, 5); // two 100µs gaps
    expect(fns[0]?.line).toBe(10); // 0-based 9 → 1-based 10
    expect(fns[0]?.app).toBe(true);
    expect(fns[1]?.functionName).toBe('depFn');
    expect(fns[1]?.selfMs).toBeCloseTo(0.1, 5);
    expect(fns[1]?.app).toBe(false); // node_modules
  });

  it('separates idle, GC, and JS buckets', () => {
    const m = model(events)!;
    expect(m.jsMs).toBeCloseTo(0.3, 5);
    expect(m.gcMs).toBeCloseTo(0.1, 5);
    expect(m.idleMs).toBeCloseTo(0.1, 5);
  });

  it('excludes warmup samples', () => {
    // cut off after the two appFn samples and the depFn sample (t ≤ 1210)
    const m = model(events, { warmupEndUs: 1250 })!;
    expect(m.functions).toHaveLength(0); // all JS samples were in warmup
    expect(m.jsMs).toBeCloseTo(0, 5);
  });

  it('nets out out-of-order (negative-delta) samples instead of going negative', () => {
    // swap two samples in time via a negative delta; appFn time must stay >= 0
    const oo = [
      profileStart('0x2', 100, 1000),
      chunk('0x2', 100, NODES, [2, 2, 2, 1], [100, 200, -150, 100]),
    ];
    const m = model(oo)!;
    expect(m.jsMs).toBeGreaterThanOrEqual(0);
    expect(m.functions[0]?.functionName).toBe('appFn');
    expect(m.functions[0]?.selfMs).toBeGreaterThanOrEqual(0);
  });

  it('selects the renderer process, not a same-id extension profile', () => {
    const withExtension = [
      ...events,
      profileStart('0x2', 999, 1000), // extension reuses id 0x2 in another pid
      chunk(
        '0x2',
        999,
        [
          {
            id: 9,
            functionName: 'extHot',
            url: 'http://ext/bundle.js',
            lineNumber: 0,
            parent: 1,
          },
        ],
        [9, 9, 9],
        [100, 5000, 5000],
      ),
    ];
    const m = model(withExtension, { mainPid: 100 })!;
    expect(m.functions.some((f) => f.functionName === 'extHot')).toBe(false);
    expect(m.functions[0]?.functionName).toBe('appFn');
  });
});
