#!/usr/bin/env node
/**
 * perftale CLI.
 *
 * `analyze <trace.json[.gz]> [--fps <n>] [--debug] [--out <path>|--json]`
 * streams the trace once and prints the frame + JS models. The default report
 * is consumer-facing (smoothness verdict + where the budget goes); `--debug`
 * adds the pipeline's own diagnostics. `--out`/`--json` also persist the
 * structured summary for an agent (or a later run) to read back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { analyzeTrace, type Analysis } from '../src/analyze.ts';
import { buildSummary, serializeSummary } from '../src/summary.ts';

const USAGE = `perftale — Chrome trace → actionable insights

Usage:
  perftale analyze <trace.json[.gz]> [--fps <n>] [--debug] [--out <path>|--json]

  --fps <n>     override the detected refresh rate
  --debug       include pipeline diagnostics (noise reduction, latency, clusters)
  --out <path>  write the structured summary JSON to <path>
  --json        write the summary JSON to .perftale/<trace>.summary.json
`;

/** Default artifact path for --json: .perftale/<trace-basename>.summary.json */
function defaultOutPath(file: string): string {
  const stem = basename(file).replace(/\.json(\.gz)?$/i, '');
  return join('.perftale', `${stem}.summary.json`);
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Trim a source url to a filename (and one parent dir for app paths), no query. */
function shortenUrl(url: string): string {
  const noQuery = url.split('?')[0] ?? url;
  const parts = noQuery.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || noQuery;
}

function report(
  file: string,
  analysis: Analysis,
  elapsedMs: number,
  debug: boolean,
): string {
  const { reduction: r, frames: f } = analysis;
  const out: string[] = [];

  out.push(`perftale — ${file}`);

  // Pipeline plumbing — only meaningful while developing the tool.
  if (debug) {
    out.push('');
    out.push('SIZE');
    out.push(
      `  ${r.total.toLocaleString()} events → ${r.kept.toLocaleString()} kept ` +
        `(${pct(r.kept, r.total)}), ${r.dropped.toLocaleString()} noise dropped ` +
        `(${pct(r.dropped, r.total)})`,
    );
  }

  out.push('');
  out.push('FRAMES');
  const src =
    f.refresh.source === 'detected'
      ? `detected, ${(f.refresh.confidence * 100).toFixed(0)}% confidence`
      : f.refresh.source;
  out.push(
    `  refresh:       ${f.refresh.hz}Hz (${f.refresh.intervalMs.toFixed(2)}ms budget, ${src})`,
  );
  if (f.warmupMs > 0) {
    out.push(
      `  warmup:        first ${f.warmupMs.toFixed(0)}ms excluded (profiling overhead)`,
    );
  }
  out.push(`  window:        ${(f.windowMs / 1000).toFixed(2)}s analyzed`);
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
  if (debug) {
    out.push(
      `  pipeline lat.: p50 ${f.pipelineLatencyMs.p50.toFixed(1)}ms / ` +
        `p95 ${f.pipelineLatencyMs.p95.toFixed(1)}ms / max ${f.pipelineLatencyMs.max.toFixed(1)}ms ` +
        `(latency, not frame interval)`,
    );
  }

  if (f.mainThread.length > 0) {
    out.push('');
    out.push('  main-thread frame time (where the budget goes):');
    for (const p of f.mainThread) {
      out.push(
        `    ${p.totalMs.toFixed(1).padStart(8)}ms  ${p.sharePct.toFixed(0).padStart(3)}%  ${p.label}`,
      );
    }
  }

  const prof = analysis.profile;
  if (prof && prof.functions.length > 0) {
    out.push('');
    out.push('JS (self-time by function)');
    out.push(
      `  active CPU ${prof.activeMs.toFixed(0)}ms: ` +
        `${prof.jsMs.toFixed(0)}ms JS / ${prof.nativeMs.toFixed(0)}ms engine+native / ` +
        `${prof.gcMs.toFixed(0)}ms GC  (idle ${prof.idleMs.toFixed(0)}ms)`,
    );
    out.push('');
    const shown = debug ? prof.functions : prof.functions.slice(0, 15);
    for (const fn of shown) {
      const tag = fn.app ? 'APP' : '   ';
      const where = `${shortenUrl(fn.url)}:${fn.line}`;
      out.push(
        `  ${fn.selfMs.toFixed(1).padStart(7)}ms ${fn.sharePct.toFixed(0).padStart(3)}% ${tag}  ` +
          `${fn.functionName}  ${where}`,
      );
    }
    if (!debug && prof.functions.length > shown.length) {
      out.push(`  … and ${prof.functions.length - shown.length} more (--debug)`);
    }
  }

  if (debug && f.droppedClusters.length > 0) {
    out.push('');
    out.push('  dropped-frame clusters:');
    for (const c of f.droppedClusters) {
      out.push(
        `    ${(c.startMs / 1000).toFixed(2)}s–${(c.endMs / 1000).toFixed(2)}s  ${c.count} frame(s)`,
      );
    }
  }

  if (debug) {
    out.push('');
    out.push(`scanned in ${(elapsedMs / 1000).toFixed(1)}s`);
  }
  return out.join('\n');
}

interface Args {
  file?: string;
  fps?: number;
  debug: boolean;
  out?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { debug: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fps') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) result.fps = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (value) result.out = value;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--debug') {
      result.debug = true;
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

const { file, fps, debug, out, json } = parseArgs(rest);
if (!file) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const start = performance.now();
const analysis = await analyzeTrace(file, { ...(fps ? { fps } : {}) });
const elapsed = performance.now() - start;
process.stdout.write(report(file, analysis, elapsed, debug) + '\n');

const outPath = out ?? (json ? defaultOutPath(file) : undefined);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeSummary(buildSummary(basename(file), analysis)));
  process.stderr.write(`summary written to ${outPath}\n`);
}
