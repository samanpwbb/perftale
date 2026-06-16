import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTrace } from '../src/analyze.ts';
import { buildSummary, serializeSummary } from '../src/summary.ts';

// The real traces are gitignored and large, so this runs only on a machine
// that has them. The committed examples/*.summary.json are the reference; if a
// model change shifts the numbers, regenerate with `pnpm analyze:real` and
// review the diff. In CI (no traces) these are skipped.
const CASES = [
  { trace: 'orb-ball-trace.json.gz', summary: 'examples/orb-ball-trace.summary.json' },
  {
    trace: 'pile-up-poker-trace.json.gz',
    summary: 'examples/pile-up-poker-trace.summary.json',
  },
];

describe('example summaries match the real traces', () => {
  for (const { trace, summary } of CASES) {
    const have = existsSync(trace) && existsSync(summary);
    it.skipIf(!have)(`${trace} reproduces ${summary}`, async () => {
      const analysis = await analyzeTrace(trace);
      const produced = serializeSummary(buildSummary(trace, analysis));
      expect(produced).toBe(readFileSync(summary, 'utf8'));
    });
  }
});
