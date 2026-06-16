#!/usr/bin/env node
/**
 * Local-only harness: analyze the real example traces (gitignored, large) and
 * write their structured summaries to examples/, which ARE committed as
 * human-reviewable reference outputs. Re-run after changing a model to see the
 * summaries' diff — this is how we carry results forward.
 *
 *   pnpm analyze:real
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { analyzeTrace } from '../src/analyze.ts';
import { buildSummary, serializeSummary } from '../src/summary.ts';

const TRACES = ['orb-ball-trace.json.gz', 'pile-up-poker-trace.json.gz'];

mkdirSync('examples', { recursive: true });

let wrote = 0;
for (const trace of TRACES) {
  if (!existsSync(trace)) {
    process.stderr.write(`skip: ${trace} not found locally\n`);
    continue;
  }
  const analysis = await analyzeTrace(trace);
  const stem = trace.replace(/\.json(\.gz)?$/i, '');
  const out = `examples/${stem}.summary.json`;
  writeFileSync(out, serializeSummary(buildSummary(trace, analysis)));
  process.stdout.write(`wrote ${out}\n`);
  wrote++;
}

if (wrote === 0) {
  process.stderr.write('no traces found — nothing to do\n');
  process.exit(1);
}
