import { describe, expect, it } from 'vitest';
import { buildReactModel, isReactTimingEvent, mostRerendered } from '../src/react.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const ZW = '​'; // U+200B, React DevTools' component-measure prefix

/** A React DevTools component measure edge (begin or end) at `tsUs`. */
function measure(name: string, ph: 'b' | 'e', tsUs: number, tid = 1): TraceEvent {
  return { name: `${ZW}${name}`, ph, ts: tsUs, cat: 'blink.user_timing', pid: 1, tid };
}

function model(events: TraceEvent[], opts = {}) {
  return buildReactModel(events, opts);
}

describe('isReactTimingEvent', () => {
  it('matches zero-width-prefixed user_timing begin/end edges only', () => {
    expect(isReactTimingEvent(measure('Button', 'b', 0))).toBe(true);
    expect(isReactTimingEvent(measure('Button', 'e', 0))).toBe(true);
    // Non-prefixed user timing (e.g. React's "Update" marker) is not a component.
    expect(
      isReactTimingEvent({ name: 'Update', ph: 'b', ts: 0, cat: 'blink.user_timing' }),
    ).toBe(false);
    // Wrong category / phase.
    expect(
      isReactTimingEvent({
        name: `${ZW}Button`,
        ph: 'X',
        ts: 0,
        cat: 'blink.user_timing',
      }),
    ).toBe(false);
    expect(
      isReactTimingEvent({
        name: `${ZW}Button`,
        ph: 'b',
        ts: 0,
        cat: 'devtools.timeline',
      }),
    ).toBe(false);
  });
});

describe('buildReactModel', () => {
  it('returns null when the trace has no component measures', () => {
    expect(model([])).toBeNull();
    expect(
      model([{ name: 'Update', ph: 'b', ts: 0, cat: 'blink.user_timing', tid: 1 }]),
    ).toBeNull();
  });

  it('charges self vs inclusive time across nested component spans', () => {
    // Parent 1000–2000µs (1.0ms) wraps Child 1200–1500µs (0.3ms).
    const m = model([
      measure('Parent', 'b', 1000),
      measure('Child', 'b', 1200),
      measure('Child', 'e', 1500),
      measure('Parent', 'e', 2000),
    ])!;
    expect(m).not.toBeNull();
    const parent = m.components.find((c) => c.name === 'Parent')!;
    const child = m.components.find((c) => c.name === 'Child')!;
    expect(parent.totalMs).toBeCloseTo(1.0, 5);
    expect(parent.selfMs).toBeCloseTo(0.7, 5); // 1.0 inclusive − 0.3 child
    expect(child.totalMs).toBeCloseTo(0.3, 5);
    expect(child.selfMs).toBeCloseTo(0.3, 5);
    expect(m.renderCount).toBe(2);
    // Only the root span counts toward wall-clock React render time.
    expect(m.totalRenderMs).toBeCloseTo(1.0, 5);
    expect(m.componentCount).toBe(2);
  });

  it('aggregates repeated renders of the same component and ranks by self time', () => {
    const m = model([
      // Button renders twice (0.2ms + 0.2ms self), Table once (0.5ms self).
      measure('Button', 'b', 0),
      measure('Button', 'e', 200),
      measure('Button', 'b', 1000),
      measure('Button', 'e', 1200),
      measure('Table', 'b', 2000),
      measure('Table', 'e', 2500),
    ])!;
    expect(m.components[0]?.name).toBe('Table'); // most self time first
    expect(m.components[0]?.selfMs).toBeCloseTo(0.5, 5);
    const button = m.components.find((c) => c.name === 'Button')!;
    expect(button.count).toBe(2);
    expect(button.selfMs).toBeCloseTo(0.4, 5);
    expect(mostRerendered(m)?.name).toBe('Button'); // 2 renders vs 1
    // Shares are over total self time (0.5 + 0.4 = 0.9ms).
    expect(m.components[0]?.sharePct).toBeCloseTo((0.5 / 0.9) * 100, 4);
  });

  it('excludes renders that began during profiling warmup', () => {
    const m = model(
      [
        measure('Early', 'b', 500),
        measure('Early', 'e', 900),
        measure('Late', 'b', 1500),
        measure('Late', 'e', 2000),
      ],
      { warmupEndUs: 1000 },
    )!;
    expect(m.components.map((c) => c.name)).toEqual(['Late']);
    expect(m.totalRenderMs).toBeCloseTo(0.5, 5);
  });

  it('ignores measures from other renderer processes', () => {
    const m = model(
      [
        measure('App', 'b', 0),
        measure('App', 'e', 1000),
        { ...measure('Ext', 'b', 0), pid: 999 },
        { ...measure('Ext', 'e', 5000), pid: 999 },
      ],
      { mainPid: 1 },
    )!;
    expect(m.components.map((c) => c.name)).toEqual(['App']);
  });
});
