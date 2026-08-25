import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTrace, type Analysis } from '../src/analyze.ts';
import { renderReport } from '../src/report.ts';

// Lock the human-facing text report against the committed fixtures. Rendered
// with color:false so the snapshot is plain text (no ANSI), and with the bare
// filename so the header line is machine-independent. If the format changes on
// purpose, `vitest -u` and review the diff — that diff is the format review.

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.trace.json.gz'));

/** The first fixture, parsed once and shared by the non-snapshot cases. */
const firstTrace = fixtures[0];
let cached: Promise<Analysis> | null = null;
function firstAnalysis(): Promise<Analysis> {
  if (!firstTrace) throw new Error('no fixtures');
  cached ??= analyzeTrace(join(FIXTURE_DIR, firstTrace));
  return cached;
}

/** A bare ANSI SGR start sequence (ESC + '['), built without a literal escape. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

describe('renderReport', () => {
  for (const trace of fixtures) {
    it(`${trace} renders a stable default report`, async () => {
      const analysis = await analyzeTrace(join(FIXTURE_DIR, trace));
      expect(renderReport(trace, analysis, { color: false })).toMatchSnapshot();
    });

    it(`${trace} renders a stable --debug report`, async () => {
      const analysis = await analyzeTrace(join(FIXTURE_DIR, trace));
      expect(
        renderReport(trace, analysis, { color: false, debug: true, elapsedMs: 0 }),
      ).toMatchSnapshot();
    });
  }

  // No committed fixture crosses the anonymous-share threshold, so drive the
  // branch from the verdict's conclusion — the report renders `anonBlindspot`,
  // it does not re-decide it — and check it points the reader at the file rollup.
  it('flags the JS table when the verdict reports an anonymous blind spot', async () => {
    const analysis = await firstAnalysis();
    expect(renderReport('t', analysis, { color: false })).not.toContain(
      'of this is in (anonymous) rows',
    );

    const flagged = renderReport(
      't',
      {
        ...analysis,
        verdict: { ...analysis.verdict, anonBlindspot: { selfMs: 120, sharePct: 30 } },
      },
      { color: false },
    );
    expect(flagged).toContain('120ms (30%) of this is in (anonymous) rows');
    expect(flagged).toContain('read FILES below');
  });

  it('emits ANSI only when color is enabled', async () => {
    const analysis = await firstAnalysis();
    expect(ANSI.test(renderReport('t', analysis, { color: false }))).toBe(false);
    expect(ANSI.test(renderReport('t', analysis, { color: true }))).toBe(true);
  });
});
