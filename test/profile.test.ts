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

/** Sweeps app, app, dep, gc, idle, root; each charged gap is 100µs. */
const SWEEP_EVENTS = [
  profileStart('0x2', 100, 1000),
  chunk('0x2', 100, NODES, [2, 2, 4, 5, 3, 1], [10, 100, 100, 100, 100, 100]),
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
  const events = SWEEP_EVENTS;

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

// The blind spot this rollup exists for: cost that lives in callbacks is
// reported as `(anonymous)` and splinters across one row per call site, so a
// file can be the most expensive thing in the trace and still rank below
// cheaper named functions. `files` must see what `functions` cannot.
const CALLBACK_NODES: NodeSpec[] = [
  { id: 1, functionName: '(root)' },
  {
    id: 2,
    functionName: 'namedFn',
    url: 'http://localhost/src/app.ts',
    lineNumber: 9,
    parent: 1,
  },
  // Three anonymous call frames in one file — a scheduler's queued callbacks.
  {
    id: 6,
    functionName: '',
    url: 'http://localhost/src/notifier.ts',
    lineNumber: 4,
    parent: 1,
  },
  {
    id: 7,
    functionName: '',
    url: 'http://localhost/src/notifier.ts',
    lineNumber: 19,
    parent: 1,
  },
  {
    id: 8,
    functionName: '',
    url: 'http://localhost/src/notifier.ts',
    lineNumber: 39,
    parent: 1,
  },
];

describe('buildProfileModel file rollup', () => {
  // samples: namedFn ×2, then one tick in each anonymous notifier frame.
  const events = [
    profileStart('0x2', 100, 1000),
    chunk('0x2', 100, CALLBACK_NODES, [2, 2, 6, 7, 8, 1], [10, 100, 100, 100, 100, 100]),
  ];

  it('ranks a file above the functions it outweighs individually', () => {
    const m = model(events)!;
    // By function, the named one wins: each anonymous frame is only 0.1ms.
    expect(m.functions[0]?.functionName).toBe('namedFn');
    expect(m.functions[0]?.selfMs).toBeCloseTo(0.2, 5);
    // By file, the callbacks add up and win.
    expect(m.files.app[0]?.url).toBe('http://localhost/src/notifier.ts');
    expect(m.files.app[0]?.selfMs).toBeCloseTo(0.3, 5);
    expect(m.files.app[1]?.url).toBe('http://localhost/src/app.ts');
    expect(m.files.app[1]?.selfMs).toBeCloseTo(0.2, 5);
  });

  it('records how a file’s cost is spread, and how much is anonymous', () => {
    const m = model(events)!;
    const notifier = m.files.app[0]!;
    expect(notifier.functionCount).toBe(3);
    expect(notifier.anonymousMs).toBeCloseTo(0.3, 5);
    const app = m.files.app[1]!;
    expect(app.functionCount).toBe(1);
    expect(app.anonymousMs).toBe(0);
  });

  it('keeps the anonymity flag out of the serialized functions', () => {
    const m = model(events)!;
    expect(m.functions[0]).not.toHaveProperty('anon');
  });

  it('measures the trace-wide anonymous share of JS self-time', () => {
    const m = model(events)!;
    expect(m.jsMs).toBeCloseTo(0.5, 5);
    expect(m.anonymousMs).toBeCloseTo(0.3, 5);
    expect(m.anonymousSharePct).toBeCloseTo(60, 5);
  });

  it('tags dependency files and splits the totals', () => {
    const m = model(SWEEP_EVENTS)!;
    expect(m.fileCount).toBe(2);
    expect(m.appMs).toBeCloseTo(0.2, 5);
    expect(m.depMs).toBeCloseTo(0.1, 5);
    expect(m.files.app[0]?.url).toBe('http://localhost/src/app.ts');
    expect(m.files.dep[0]?.url).toBe('http://localhost/node_modules/x.js');
    // Shares are of attributed JS time, so they sum with the function shares.
    const all = [...m.files.app, ...m.files.dep];
    expect(all.reduce((n, f) => n + f.sharePct, 0)).toBeCloseTo(100, 5);
  });

  it('truncates first-party and dependency files separately', () => {
    // Two app files and two dep files; topFiles:1 must keep one of each rather
    // than letting whichever group is hotter take both slots.
    const nodes: NodeSpec[] = [
      { id: 1, functionName: '(root)' },
      { id: 2, functionName: 'a', url: 'http://x/src/a.ts', lineNumber: 0, parent: 1 },
      { id: 3, functionName: 'b', url: 'http://x/src/b.ts', lineNumber: 0, parent: 1 },
      {
        id: 4,
        functionName: 'c',
        url: 'http://x/node_modules/c.js',
        lineNumber: 0,
        parent: 1,
      },
      {
        id: 5,
        functionName: 'd',
        url: 'http://x/node_modules/d.js',
        lineNumber: 0,
        parent: 1,
      },
    ];
    const m = model(
      [
        profileStart('0x2', 100, 1000),
        chunk('0x2', 100, nodes, [4, 5, 2, 3, 1], [10, 400, 300, 200, 100]),
      ],
      { topFiles: 1 },
    )!;
    expect(m.fileCount).toBe(4);
    expect(m.files.app).toHaveLength(1);
    expect(m.files.dep).toHaveLength(1);
  });
});
