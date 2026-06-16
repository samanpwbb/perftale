import { describe, expect, it } from 'vitest';
import { buildFrameModel, isFrameEvent } from '../src/frames.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const FRAME_CAT = 'disabled-by-default-devtools.timeline.frame';

function instant(name: string, ts: number): TraceEvent {
  return { name, ph: 'I', ts, cat: FRAME_CAT, s: 't' };
}

function mainFrame(ts: number, breakdown: Record<string, number>): TraceEvent {
  return {
    name: 'SendBeginMainFrameToCommit',
    ph: 'b',
    ts,
    cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame',
    id2: { local: '0x1' },
    args: { send_begin_mainframe_to_commit_breakdown: breakdown },
  };
}

// 60Hz cadence; 4 presented frames with a freeze (2 dropped frames) in the middle.
const BUDGET = 16667; // µs ≈ 1/60s
function scene(): TraceEvent[] {
  return [
    instant('BeginFrame', 0),
    instant('BeginFrame', BUDGET),
    instant('BeginFrame', BUDGET * 2),
    instant('BeginFrame', BUDGET * 3),
    instant('BeginFrame', BUDGET * 4),
    instant('DrawFrame', 0),
    instant('DrawFrame', BUDGET),
    instant('DrawFrame', BUDGET * 2),
    instant('DrawFrame', 100_000), // after the freeze
    instant('DroppedFrame', BUDGET * 3),
    instant('DroppedFrame', BUDGET * 4),
    mainFrame(BUDGET, {
      paint_us: 2000,
      layout_update_us: 1000,
      animate_us: 500,
      accessibility_update_us: 0, // dropped: not > 0
      begin_main_sent_to_started_us: 1.8e19, // dropped: sentinel
    }),
  ];
}

describe('isFrameEvent', () => {
  it('selects only the frame-relevant event names', () => {
    expect(isFrameEvent(instant('DrawFrame', 0))).toBe(true);
    expect(isFrameEvent(instant('PipelineReporter', 0))).toBe(true);
    expect(isFrameEvent({ name: 'FunctionCall', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildFrameModel', () => {
  it('detects 60Hz from BeginFrame cadence', () => {
    const m = buildFrameModel(scene());
    expect(m.refresh.hz).toBe(60);
    expect(m.refresh.source).toBe('detected');
    expect(m.refresh.confidence).toBe(1);
    expect(m.refresh.intervalMs).toBeCloseTo(16.667, 2);
  });

  it('honours an explicit fps override', () => {
    const m = buildFrameModel(scene(), { fps: 120 });
    expect(m.refresh.hz).toBe(120);
    expect(m.refresh.source).toBe('override');
    expect(m.refresh.intervalMs).toBeCloseTo(8.333, 2);
  });

  it('counts presented vs dropped frames', () => {
    const m = buildFrameModel(scene());
    expect(m.presented).toBe(4);
    expect(m.dropped).toBe(2);
    expect(m.droppedPct).toBeCloseTo((2 / 6) * 100, 5);
  });

  it('measures the freeze span around a dropped-frame cluster', () => {
    const m = buildFrameModel(scene());
    // last DrawFrame before the cluster is at 2*BUDGET; first after is at 100_000µs
    expect(m.worstFreezeMs).toBeCloseTo((100_000 - BUDGET * 2) / 1000, 3);
    expect(m.worstFreezeAtMs).toBeCloseTo((BUDGET * 2) / 1000, 3);
    expect(m.jankGapCount).toBe(1);
    expect(m.droppedClusters).toHaveLength(1);
    expect(m.droppedClusters[0]?.count).toBe(2);
  });

  it('breaks down main-thread frame time, filtering zeros and sentinels', () => {
    const m = buildFrameModel(scene());
    expect(m.mainThread.map((p) => p.key)).toEqual([
      'paint_us',
      'layout_update_us',
      'animate_us',
    ]);
    const paint = m.mainThread[0];
    expect(paint?.label).toBe('paint');
    expect(paint?.totalMs).toBeCloseTo(2, 5);
    expect(paint?.sharePct).toBeCloseTo((2000 / 3500) * 100, 3);
  });

  it('is deterministic across runs', () => {
    expect(JSON.stringify(buildFrameModel(scene()))).toBe(
      JSON.stringify(buildFrameModel(scene())),
    );
  });
});
