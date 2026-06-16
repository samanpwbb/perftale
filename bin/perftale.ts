#!/usr/bin/env node
/**
 * perftale CLI.
 *
 * Step 2: `analyze <trace.json[.gz]> [--fps <n>]` streams the trace once,
 * reports the noise reduction, and prints the frame model (refresh, dropped
 * frames, hitches, and where main-thread frame time goes). JS attribution and
 * the full summary land in later steps.
 */
import { analyzeTrace, type Analysis } from '../src/analyze.ts';

const USAGE = `perftale — Chrome trace → actionable insights

Usage:
  perftale analyze <trace.json[.gz]> [--fps <n>]
`;

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function report(file: string, analysis: Analysis, elapsedMs: number): string {
  const { reduction: r, frames: f } = analysis;
  const out: string[] = [];

  out.push(`perftale — ${file}`);
  out.push('');
  out.push('SIZE');
  out.push(
    `  ${r.total.toLocaleString()} events → ${r.kept.toLocaleString()} kept ` +
      `(${pct(r.kept, r.total)}), ${r.dropped.toLocaleString()} noise dropped ` +
      `(${pct(r.dropped, r.total)})`,
  );

  out.push('');
  out.push('FRAMES');
  const src =
    f.refresh.source === 'detected'
      ? `detected, ${(f.refresh.confidence * 100).toFixed(0)}% confidence`
      : f.refresh.source;
  out.push(
    `  refresh:       ${f.refresh.hz}Hz (${f.refresh.intervalMs.toFixed(2)}ms budget, ${src})`,
  );
  out.push(`  window:        ${(f.windowMs / 1000).toFixed(2)}s`);
  out.push(
    `  presented:     ${f.presented} frames (${f.presentationFps.toFixed(1)} fps avg, incl. idle vsyncs)`,
  );
  out.push(
    `  dropped:       ${f.dropped} frames — ${f.droppedPct.toFixed(1)}% of attempted frames`,
  );
  if (f.dropped > 0) {
    out.push(
      `  worst freeze:  ${f.worstFreezeMs.toFixed(1)}ms at ${(f.worstFreezeAtMs / 1000).toFixed(2)}s ` +
        `(${f.jankGapCount} freeze${f.jankGapCount === 1 ? '' : 's'} from dropped frames)`,
    );
  }
  out.push(
    `  largest gap:   ${f.largestGapMs.toFixed(1)}ms at ${(f.largestGapAtMs / 1000).toFixed(2)}s ` +
      `(idle or main-thread block — see tasks)`,
  );
  out.push(
    `  pipeline lat.: p50 ${f.pipelineLatencyMs.p50.toFixed(1)}ms / ` +
      `p95 ${f.pipelineLatencyMs.p95.toFixed(1)}ms / max ${f.pipelineLatencyMs.max.toFixed(1)}ms ` +
      `(latency, not frame interval)`,
  );

  if (f.mainThread.length > 0) {
    out.push('');
    out.push('  main-thread frame time (where the budget goes):');
    for (const p of f.mainThread) {
      out.push(
        `    ${p.totalMs.toFixed(1).padStart(8)}ms  ${p.sharePct.toFixed(0).padStart(3)}%  ${p.label}`,
      );
    }
  }

  if (f.droppedClusters.length > 0) {
    out.push('');
    out.push('  dropped-frame clusters:');
    for (const c of f.droppedClusters) {
      out.push(
        `    ${(c.startMs / 1000).toFixed(2)}s–${(c.endMs / 1000).toFixed(2)}s  ${c.count} frame(s)`,
      );
    }
  }

  out.push('');
  out.push(`scanned in ${(elapsedMs / 1000).toFixed(1)}s`);
  return out.join('\n');
}

function parseArgs(argv: string[]): { file?: string; fps?: number } {
  const result: { file?: string; fps?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fps') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) result.fps = value;
    } else if (arg && !arg.startsWith('-') && result.file === undefined) {
      result.file = arg;
    }
  }
  return result;
}

const [command, ...rest] = process.argv.slice(2);

if (command !== 'analyze') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { file, fps } = parseArgs(rest);
if (!file) {
  process.stderr.write('usage: perftale analyze <trace.json[.gz]> [--fps <n>]\n');
  process.exit(1);
}

const start = performance.now();
const analysis = await analyzeTrace(file, { ...(fps ? { fps } : {}) });
const elapsed = performance.now() - start;
process.stdout.write(report(file, analysis, elapsed) + '\n');
