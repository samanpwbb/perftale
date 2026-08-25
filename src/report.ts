/**
 * The human-facing text report.
 *
 * This renders the same `Analysis` the JSON artifact is built from, but for a
 * terminal: an inverted pyramid (conclusion first, then the supporting numbers)
 * with one consistent visual grammar across every section —
 *
 *   - a section is `TITLE` (bold) + a dim one-line description of what it is;
 *   - its first indented line is the section's headline number;
 *   - aligned key/value blocks use `key  value`, with `·` joining value parts;
 *   - every ranked list (JS, FILES, GC suspects, React, frame-time breakdown) shares
 *     one column layout with a dim header row, so they read the same way.
 *
 * Colour is subtle and only ever carries meaning (green = good / app code,
 * yellow·red = a problem, dim = units / locations / metadata, bold = structure)
 * and is disabled automatically when the output isn't a TTY (see `bin/perftale`).
 */
import pc from 'picocolors';
import type { Analysis } from './analyze.ts';
import type {
  CoincidenceRow,
  CoincidenceVerdict,
  FrameDropGc,
  FrameDropReflow,
} from './framedrops.ts';

const { createColors } = pc;

export interface RenderOptions {
  /** Include pipeline diagnostics (noise reduction, latency, clusters, timing). */
  debug?: boolean;
  /** Emit ANSI colour. Off → plain text (used for the snapshot fixtures). */
  color?: boolean;
  /** Wall-clock the scan took, ms — only shown in `--debug`. */
  elapsedMs?: number;
}

type Colors = ReturnType<typeof createColors>;

/** Number formatters — one canonical spelling per unit, used everywhere. */
const ms1 = (n: number): string => `${n.toFixed(1)}ms`;
const ms0 = (n: number): string => `${n.toFixed(0)}ms`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;
const pct1 = (n: number): string => `${n.toFixed(1)}%`;
const pct0 = (n: number): string => `${n.toFixed(0)}%`;

/** `1 freeze` / `3 frames` — pluralize a noun by count. */
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

const VERDICT_LABEL: Record<CoincidenceVerdict, string> = {
  implicated: 'implicated',
  coincided: 'coincided',
  cleared: 'cleared',
  'n/a': 'n/a',
  'capture-artifact': 'capture artifact',
};

/** Non-zero task categories as `scripting 62ms · paint 1ms`, in display order. */
function categorySummary(cats: {
  scripting: number;
  rendering: number;
  painting: number;
  gc: number;
  other: number;
}): string {
  const labelled: [string, number][] = [
    ['scripting', cats.scripting],
    ['layout', cats.rendering],
    ['paint', cats.painting],
    ['gc', cats.gc],
    ['other', cats.other],
  ];
  return labelled
    .filter(([, ms]) => ms >= 0.5)
    .map(([label, ms]) => `${label} ${ms0(ms)}`)
    .join(' · ');
}

/** A freeze's GC cell — explicit about absence so an agent can rule GC out. */
function gcCell(c: Colors, gc: FrameDropGc | null): string {
  if (!gc) return c.dim('no GC instrumentation');
  if (gc.count === 0) return c.dim('none in window');
  return c.yellow(`${plural(gc.count, 'pause')} · ${ms1(gc.totalMs)}`);
}

/** A freeze's reflow cell — dimmed when it's a DevTools-capture artifact. */
function reflowCell(c: Colors, r: FrameDropReflow | null): string {
  if (!r) return c.dim('none forced in trace');
  if (r.count === 0) return c.dim('none in window');
  const body = `${plural(r.count, 'forced layout')} · ${ms1(r.forcedMs)}`;
  return r.captureArtifact
    ? c.dim(`${body} — DevTools-extension artifact, ignore`)
    : c.yellow(body);
}

/**
 * Per-file anonymous share above which the `spread` cell calls it out. Purely a
 * display rule: whether the *trace* is anonymous-heavy enough to distrust the
 * function ranking is an analytical judgment, and verdict makes it once
 * (`Verdict.anonBlindspot`).
 */
const ANON_DOMINATES_PCT = 50;

/** The `file:line` cell — one spelling wherever a source location is shown. */
const srcLoc = (x: { url: string; line: number }): string =>
  `${shortenUrl(x.url)}:${x.line}`;

/**
 * How a file's cost is distributed across its functions — `4 fns`, and the
 * anonymous share when it is big enough to be why the file is missing from the
 * by-function table. `1 fn · 100% anon` reads as: one callback holds all of it,
 * and it is filed under `(anonymous)` above.
 */
function spread(f: {
  functionCount: number;
  selfMs: number;
  anonymousMs: number;
}): string {
  const fns = plural(f.functionCount, 'fn');
  const anonPct = f.selfMs > 0 ? (f.anonymousMs / f.selfMs) * 100 : 0;
  return anonPct >= ANON_DOMINATES_PCT ? `${fns} · ${pct0(anonPct)} anon` : fns;
}

/** Trim a source url to a filename (and one parent dir for app paths), no query. */
function shortenUrl(url: string): string {
  const noQuery = url.split('?')[0] ?? url;
  const parts = noQuery.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || noQuery;
}

/** Word-wrap to a fixed width (deterministic, terminal-width-independent). */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A `key  value` block with the keys right-padded to a common width. */
function kv(c: Colors, rows: [key: string, value: string][]): string[] {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.dim(k.padEnd(w))}  ${v}`);
}

interface Ranked {
  /** Primary metric, right-aligned, rendered as `N.Nms`. */
  metricMs: number;
  /** Secondary metric (e.g. `6%` or `×381`), right-aligned. */
  secondary: string;
  /** First-party tag column; omit (undefined) for tables without one. */
  app?: boolean;
  name: string;
  /** Trailing dim column — `file:line`, or a per-row note; omit when unused. */
  trailing?: string;
}

/**
 * The one ranked-list renderer every numeric table flows through, so the JS,
 * GC-suspect, React, and frame-time tables all align and read identically.
 */
function ranked(
  c: Colors,
  rows: Ranked[],
  headers: { metric: string; secondary: string; name: string; trailing?: string },
): string[] {
  const metricStrs = rows.map((r) => ms1(r.metricMs));
  const metricW = Math.max(headers.metric.length, ...metricStrs.map((s) => s.length));
  const secW = Math.max(headers.secondary.length, ...rows.map((r) => r.secondary.length));
  const hasApp = rows.some((r) => r.app !== undefined);
  const hasTrailing = rows.some((r) => r.trailing !== undefined);
  const nameW = Math.min(
    34,
    Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
  );

  const head: string[] = [
    headers.metric.padStart(metricW),
    headers.secondary.padStart(secW),
  ];
  if (hasApp) head.push('   ');
  head.push(hasTrailing ? headers.name.padEnd(nameW) : headers.name);
  if (hasTrailing) head.push(headers.trailing ?? '');

  const lines = [`  ${c.dim(head.join('  '))}`];
  rows.forEach((r, i) => {
    const cells: string[] = [
      (metricStrs[i] ?? '').padStart(metricW),
      r.secondary.padStart(secW),
    ];
    if (hasApp) cells.push(r.app ? c.green('APP') : '   ');
    cells.push(hasTrailing ? r.name.padEnd(nameW) : r.name);
    if (hasTrailing && r.trailing) cells.push(c.dim(r.trailing));
    lines.push(`  ${cells.join('  ')}`);
  });
  return lines;
}

/** A row shape every by-function table shares (`HotFunction` and its kin). */
interface FunctionRow {
  sharePct: number;
  app: boolean;
  functionName: string;
  url: string;
  line: number;
}

/**
 * Every by-function table — JS, reflow run-up, GC allocators, memory suspects —
 * has the same columns and differs only in what the metric is called, so the
 * column names live here once rather than at each call site.
 */
function rankedFunctions(
  c: Colors,
  rows: (FunctionRow & { metricMs: number })[],
  metric: string,
): string[] {
  return ranked(
    c,
    rows.map((f) => ({
      metricMs: f.metricMs,
      secondary: pct0(f.sharePct),
      app: f.app,
      name: f.functionName,
      trailing: srcLoc(f),
    })),
    { metric, secondary: 'share', name: 'function', trailing: 'location' },
  );
}

export function renderReport(
  file: string,
  analysis: Analysis,
  options: RenderOptions = {},
): string {
  const { debug = false, color = false, elapsedMs = 0 } = options;
  const c = createColors(color);
  const { verdict: v, reduction: r, frames: f, tasks } = analysis;

  const out: string[] = [];
  const blank = () => out.push('');
  /** Section header: `TITLE` (bold) + a dim description of what it is. */
  const heading = (title: string, desc: string) =>
    out.push(`${c.bold(title)}  ${c.dim(desc)}`);
  const moreLine = (rest: number) =>
    out.push(`  ${c.dim(`… and ${rest} more (--debug)`)}`);

  out.push(`${c.bold('perftale')}  ${c.dim(file)}`);

  // ── VERDICT — the conclusion, read first. ────────────────────────────────
  blank();
  out.push(c.bold('VERDICT'));
  out.push(`  ${(v.smooth ? c.green : c.yellow)(v.headline)}`);

  const rows: [string, string][] = [];
  if (v.bound !== 'idle') {
    rows.push([
      'bound',
      `${v.bound} ${c.dim(`· ${pct0(v.boundSharePct)} of main-thread frame time`)}`,
    ]);
  }
  if (v.topAppHotspot) {
    const h = v.topAppHotspot;
    rows.push([
      'hotspot',
      `${c.green(h.functionName)}  ${c.dim(srcLoc(h))} ` +
        `${c.dim(`· ${ms0(h.selfMs)} self`)}`,
    ]);
  }
  // Populated only when it disagrees with `hotspot` (verdict makes that call) —
  // and disagreement is the signal: cost buried in anonymous callbacks ranks low
  // by function, high by file.
  if (v.topAppFile) {
    const hf = v.topAppFile;
    rows.push([
      'hot file',
      `${c.green(shortenUrl(hf.url))} ` +
        `${c.dim(`· ${ms0(hf.selfMs)} self · ${pct1(hf.sharePct)} of JS`)}`,
    ]);
  }
  for (const line of kv(c, rows)) out.push(line);
  if (v.notes.length > 0) {
    out.push(`  ${c.dim('notes')}`);
    for (const note of v.notes) {
      const lines = wrap(note, 84);
      lines.forEach((ln, i) => out.push(`    ${c.dim(`${i === 0 ? '•' : ' '} ${ln}`)}`));
    }
  }

  // ── SIZE (debug) — how much noise the streaming pass dropped. ─────────────
  if (debug) {
    blank();
    heading('SIZE', 'noise reduction');
    const keptPct = r.total ? pct1((r.kept / r.total) * 100) : '0%';
    const dropPct = r.total ? pct1((r.dropped / r.total) * 100) : '0%';
    out.push(
      `  ${r.total.toLocaleString()} events → ${r.kept.toLocaleString()} kept ` +
        c.dim(`(${keptPct}), ${r.dropped.toLocaleString()} noise dropped (${dropPct})`),
    );
  }

  // ── FRAMES — did a fresh frame reach the screen every vsync? ──────────────
  blank();
  heading('FRAMES', 'smoothness');
  const src =
    f.refresh.source === 'detected'
      ? `detected, ${pct0(f.refresh.confidence * 100)} confidence`
      : f.refresh.source;
  const frameRows: [string, string][] = [
    [
      'refresh',
      `${f.refresh.hz}Hz ${c.dim(`· ${f.refresh.intervalMs.toFixed(2)}ms budget · ${src}`)}`,
    ],
  ];
  if (f.warmupMs > 0) {
    frameRows.push([
      'warmup',
      `first ${ms0(f.warmupMs)} excluded ${c.dim('(profiling overhead)')}`,
    ]);
  }
  frameRows.push(['window', `${secs(f.windowMs)} analyzed`]);
  frameRows.push([
    'presented',
    `${f.presented} frames ${c.dim(`· ${f.presentationFps.toFixed(1)} fps avg, incl. idle vsyncs`)}`,
  ]);
  const dropText = `${f.dropped} frames · ${pct1(f.droppedPct)} of attempted`;
  frameRows.push(['dropped', (f.dropped === 0 ? c.green : c.yellow)(dropText)]);
  if (v.worstFreeze) {
    const cause = v.worstFreeze.blocked
      ? ` · blocked by a ${ms0(v.worstFreeze.blockingTaskMs ?? 0)} task`
      : '';
    const freezes = `${f.jankGapCount} freeze${f.jankGapCount === 1 ? '' : 's'}`;
    frameRows.push([
      'worst freeze',
      `${ms1(f.worstFreezeMs)} at ${secs(f.worstFreezeAtMs)} ${c.dim(`· ${freezes}${cause}`)}`,
    ]);
  }
  const gapVerdict = v.largestGap.blocked
    ? `main thread blocked by a ${ms0(v.largestGap.blockingTaskMs ?? 0)} task`
    : c.dim('idle — no long task');
  frameRows.push([
    'largest gap',
    `${ms1(f.largestGapMs)} at ${secs(f.largestGapAtMs)} ${c.dim('·')} ${gapVerdict}`,
  ]);
  if (debug) {
    const p = f.pipelineLatencyMs;
    frameRows.push([
      'pipeline lat',
      `p50 ${ms1(p.p50)} / p95 ${ms1(p.p95)} / max ${ms1(p.max)} ${c.dim('(latency, not frame interval)')}`,
    ]);
  }
  for (const line of kv(c, frameRows)) out.push(line);

  if (f.mainThread.length > 0) {
    blank();
    out.push(`  ${c.dim('main-thread frame time — where the budget goes')}`);
    for (const line of ranked(
      c,
      f.mainThread.map((p) => ({
        metricMs: p.totalMs,
        secondary: pct0(p.sharePct),
        name: p.label,
      })),
      { metric: 'time', secondary: 'share', name: 'phase' },
    )) {
      out.push(line);
    }
  }

  // ── FRAME DROPS — where the work went during each freeze, + coincidence. ──
  const fd = analysis.frameDrops;
  if (fd && fd.drops.length > 0) {
    blank();
    heading('FRAME DROPS', 'where the work went during each freeze');
    const co = fd.coincidence;
    const implicated = [
      co.longTask.verdict === 'implicated' && 'long tasks',
      co.gc.verdict === 'implicated' && 'GC',
      co.reflow.verdict === 'implicated' && 'reflow',
    ].filter((x): x is string => Boolean(x));
    const lead = implicated.length
      ? `${implicated.join(', ')} implicated`
      : 'no single cause implicated';
    out.push(
      `  ${plural(fd.count, 'freeze', 'freezes')} · ${plural(fd.droppedFrames, 'frame')} dropped ${c.dim(`· ${lead}`)}`,
    );

    const shown = debug ? fd.drops : fd.drops.slice(0, 5);
    for (const d of shown) {
      blank();
      out.push(
        `  freeze ${ms1(d.durMs)} at ${secs(d.startMs)} ` +
          c.dim(`· ${plural(d.droppedFrames, 'frame')} dropped`),
      );
      const rows: [string, string][] = [['cause', d.note]];
      if (d.blockingTask) {
        const t = d.blockingTask;
        const cats = categorySummary(t.categories);
        rows.push([
          'blocked by',
          `${ms1(t.durMs)} ${t.trigger}${cats ? c.dim(` · ${cats}`) : ''}`,
        ]);
      }
      const w = d.work;
      rows.push([
        'cpu in freeze',
        `${ms1(w.jsMs)} JS · ${ms1(w.nativeMs)} native · ${ms1(w.gcMs)} GC`,
      ]);
      const top = w.top[0];
      if (top) {
        const name = top.app ? c.green(top.functionName) : top.functionName;
        rows.push([
          'hottest',
          `${name}  ${c.dim(`${srcLoc(top)} · ${ms1(top.selfMs)} self`)}`,
        ]);
      }
      rows.push(['gc', gcCell(c, d.gc)]);
      rows.push(['reflow', reflowCell(c, d.reflow)]);
      for (const line of kv(c, rows)) out.push(line);
    }
    if (fd.drops.length > shown.length) moreLine(fd.drops.length - shown.length);

    blank();
    out.push(`  ${c.dim('coincidence across the trace')}`);
    const coRows: [string, CoincidenceRow][] = [
      ['long tasks', co.longTask],
      ['gc', co.gc],
      ['reflow', co.reflow],
    ];
    const labelW = Math.max(...coRows.map(([l]) => l.length));
    const freezeWord = (n: number): string =>
      `${n} of ${plural(fd.count, 'freeze', 'freezes')}`;
    const countsOf = (row: CoincidenceRow): string => {
      if (row.total === 0) return '—';
      if (row.freezesCaused > 0)
        return `${row.total} total · caused ${freezeWord(row.freezesCaused)}`;
      if (row.freezesNear > 0)
        return `${row.total} total · near ${freezeWord(row.freezesNear)}`;
      return `${row.total} total · ${freezeWord(0)}`;
    };
    const countsW = Math.max(...coRows.map(([, r]) => countsOf(r).length));
    for (const [label, row] of coRows) {
      const color =
        row.verdict === 'implicated'
          ? c.yellow
          : row.verdict === 'cleared'
            ? c.green
            : c.dim;
      out.push(
        `  ${c.dim(label.padEnd(labelW))}  ${countsOf(row).padEnd(countsW)}  ` +
          color(`→ ${VERDICT_LABEL[row.verdict]}`),
      );
    }
  }

  // ── LONG TASKS — main-thread tasks that block the whole frame loop. ───────
  if (tasks.longTasks.length > 0) {
    blank();
    heading('LONG TASKS', `main-thread tasks over ${tasks.longTaskMs}ms`);
    const n = tasks.longTaskCount;
    out.push(`  ${n} task${n === 1 ? '' : 's'}, ${ms0(tasks.totalLongTaskMs)} total`);
    const shown = debug ? tasks.longTasks : tasks.longTasks.slice(0, 5);
    const w = Math.max(...shown.map((t) => ms1(t.durMs).length));
    for (const t of shown) {
      const atStr = `at ${secs(t.startMs)}`;
      const cats = categorySummary(t.categories);
      out.push(
        `  ${ms1(t.durMs).padStart(w)}  ${c.dim(atStr)}  ${t.trigger}` +
          (cats ? c.dim(` · ${cats}`) : ''),
      );
      if (t.hotFunction) {
        const h = t.hotFunction;
        const name = h.app ? c.green(h.functionName) : h.functionName;
        const loc = srcLoc(h);
        const indent = ' '.repeat(2 + w + 2 + atStr.length + 2);
        out.push(
          `${indent}${c.dim('hottest:')} ${name}  ${c.dim(`${loc} · ${ms1(h.selfMs)} self`)}`,
        );
      }
    }
    if (tasks.longTasks.length > shown.length) {
      moreLine(tasks.longTasks.length - shown.length);
    }
  }

  // ── REFLOW — forced synchronous layout (layout thrashing). ────────────────
  const reflow = analysis.reflow;
  if (reflow && reflow.forcedLayoutCount + reflow.forcedStyleCount > 0) {
    blank();
    heading('REFLOW', 'forced synchronous layout');
    const total = reflow.forcedLayoutCount + reflow.forcedStyleCount;
    out.push(
      `  ${reflow.forcedLayoutCount} forced layout${reflow.forcedLayoutCount === 1 ? '' : 's'} ` +
        `+ ${reflow.forcedStyleCount} style recalc${reflow.forcedStyleCount === 1 ? '' : 's'} ` +
        c.dim(`— ${ms1(reflow.forcedMs)} total`),
    );
    const perFrame = f.presented > 0 ? total / f.presented : 0;
    const burst =
      reflow.worstBurstCount >= 2
        ? `worst burst ${reflow.worstBurstCount} in one call`
        : '';
    const rate = `~${perFrame.toFixed(1)}/frame`;
    out.push(`  ${c.dim([burst, rate].filter(Boolean).join(' · '))}`);
    if (reflow.culprits.length > 0) {
      blank();
      out.push(
        `  ${c.dim('run-up culprits — JS hottest just before forced layouts; a heuristic, batch reads before writes')}`,
      );
      const shown = debug ? reflow.culprits : reflow.culprits.slice(0, 5);
      for (const line of rankedFunctions(
        c,
        shown.map((s) => ({ ...s, metricMs: s.selfMs })),
        'run-up',
      )) {
        out.push(line);
      }
      if (reflow.culprits.length > shown.length) {
        moreLine(reflow.culprits.length - shown.length);
      }
    }
    if (debug && reflow.occurrences.length > 0) {
      blank();
      out.push(`  ${c.dim('forced layouts')}`);
      for (const o of reflow.occurrences) {
        out.push(
          `  ${ms1(o.durMs).padStart(7)}  ${c.dim(`at ${secs(o.startMs)} · ${o.kind}`)}`,
        );
      }
    }
  }

  // ── GC PRESSURE — synchronous V8 collection pauses on the main thread. ────
  const gc = analysis.gc;
  if (gc && gc.scavengeCount + gc.markCompactCount > 0) {
    blank();
    heading('GC PRESSURE', 'V8 garbage-collection pauses');
    const freed = gc.youngFreedBytes / 1e6;
    const mc =
      gc.markCompactCount > 0
        ? ` + ${gc.markCompactCount} mark-compact (${ms0(gc.markCompactMs)})`
        : '';
    out.push(
      `  ${gc.scavengeCount} scavenge${gc.scavengeCount === 1 ? '' : 's'} ` +
        `(${gc.scavengeHz.toFixed(1)}/s, ${ms0(gc.scavengeMs)})${mc} ` +
        c.dim(`— ${ms0(gc.totalGcMs)} of main-thread pauses`),
    );
    if (freed >= 1) {
      out.push(
        `  ~${freed.toFixed(0)}MB young garbage ${c.dim('(short-lived allocation churn)')}`,
      );
    }
    if (gc.suspectedAllocators.length > 0) {
      blank();
      out.push(
        `  ${c.dim('suspected allocators — JS hottest just before scavenges; a heuristic, confirm with a heap profile')}`,
      );
      const shown = debug ? gc.suspectedAllocators : gc.suspectedAllocators.slice(0, 5);
      for (const line of rankedFunctions(
        c,
        shown.map((s) => ({ ...s, metricMs: s.preGcMs })),
        'pre-gc',
      )) {
        out.push(line);
      }
      if (gc.suspectedAllocators.length > shown.length) {
        moreLine(gc.suspectedAllocators.length - shown.length);
      }
    }
    if (debug && gc.pauses.length > 0) {
      blank();
      out.push(`  ${c.dim('longest pauses')}`);
      for (const p of gc.pauses) {
        const mb = p.freedBytes / 1e6;
        const freedStr = mb >= 1 ? `, ~${mb.toFixed(0)}MB freed` : '';
        out.push(
          `  ${ms1(p.durMs).padStart(7)}  ${c.dim(`at ${secs(p.startMs)} · ${p.kind}${freedStr}`)}`,
        );
      }
    }
  }

  // ── MEMORY — retained-memory growth from the DevTools Memory counters. ────
  const mem = analysis.memory;
  if (mem) {
    blank();
    heading('MEMORY', 'retained memory over the recording (DevTools counters)');
    const mv = v.memory;
    const verdictCell =
      mv?.leak === 'likely'
        ? c.yellow(`leak likely · heap +${mv.heapMBPerMin.toFixed(0)}MB/min`)
        : mv?.leak === 'possible'
          ? c.yellow(`possible growth · heap +${mv.heapMBPerMin.toFixed(0)}MB/min`)
          : c.green('no sustained growth');
    const idle =
      mv && mv.idleFraction !== null ? ` · ${pct0(mv.idleFraction * 100)} idle` : '';
    out.push(`  ${verdictCell}${c.dim(`${idle} · ${secs(mem.spanMs)} window`)}`);

    const mb = (n: number) => `${(n / 1e6).toFixed(1)}MB`;
    const num = (n: number) => Math.round(n).toLocaleString();
    const counterRow = (
      label: string,
      t: typeof mem.heap,
      heap: boolean,
    ): [string, string] => {
      const fmt = heap ? mb : num;
      let trend: string;
      let range: string;
      if (heap) {
        // Raw first→last, plus the floor rate (the leak signal) and sawtooth range.
        range = `${fmt(t.first)} → ${fmt(t.last)}`;
        trend = t.growing
          ? c.yellow(`floor +${((t.slopePerSec * 60) / 1e6).toFixed(0)}MB/min`) +
            c.dim(` · range ${mb(t.min)}–${mb(t.max)}`)
          : c.dim(`floor stable · range ${mb(t.min)}–${mb(t.max)}`);
      } else if (t.growing) {
        // Describe the climb from the post-cleanup trough, not the leftover first sample.
        range = `${fmt(t.min)} → ${fmt(t.last)}`;
        trend = c.yellow(`+${num(t.growth)} never released`);
      } else {
        range = `${fmt(t.first)} → ${fmt(t.last)}`;
        trend = c.dim('stable');
      }
      return [label, `${range} ${c.dim('·')} ${trend}`];
    };
    const memRows: [string, string][] = [
      counterRow('heap', mem.heap, true),
      counterRow('listeners', mem.listeners, false),
      counterRow('nodes', mem.nodes, false),
      counterRow('documents', mem.documents, false),
    ];
    blank();
    for (const line of kv(c, memRows)) out.push(line);

    if (mem.growing && mem.suspects.length > 0) {
      blank();
      out.push(
        `  ${c.dim('suspected sources — JS hottest while memory grew; a lead, confirm with a heap snapshot')}`,
      );
      const shown = debug ? mem.suspects : mem.suspects.slice(0, 5);
      for (const line of rankedFunctions(
        c,
        shown.map((s) => ({ ...s, metricMs: s.selfMs })),
        'during',
      )) {
        out.push(line);
      }
      if (mem.suspects.length > shown.length)
        moreLine(mem.suspects.length - shown.length);
    }
  }

  // ── REACT — component renders, straight from React DevTools timing. ───────
  const react = analysis.react;
  if (react && react.components.length > 0) {
    blank();
    heading('REACT', 'component renders, via React DevTools');
    out.push(
      `  ${react.renderCount} renders across ${react.componentCount} components ` +
        c.dim(`· ${ms1(react.totalRenderMs)} wall-clock`),
    );
    const shown = debug ? react.components : react.components.slice(0, 10);
    for (const line of ranked(
      c,
      shown.map((cmp) => ({
        metricMs: cmp.selfMs,
        secondary: `×${cmp.count}`,
        name: cmp.name,
      })),
      { metric: 'self', secondary: 'renders', name: 'component' },
    )) {
      out.push(line);
    }
    if (react.components.length > shown.length) {
      moreLine(react.components.length - shown.length);
    }
  }

  // ── JS — self-time by function: the code to actually open and fix. ────────
  const prof = analysis.profile;
  if (prof && prof.functions.length > 0) {
    blank();
    heading('JS', 'self-time by function');
    out.push(
      `  active CPU ${ms0(prof.activeMs)}: ${ms0(prof.jsMs)} JS / ` +
        `${ms0(prof.nativeMs)} engine+native / ${ms0(prof.gcMs)} GC ` +
        c.dim(`(idle ${ms0(prof.idleMs)})`),
    );
    const shown = debug ? prof.functions : prof.functions.slice(0, 15);
    for (const line of rankedFunctions(
      c,
      shown.map((fn) => ({ ...fn, metricMs: fn.selfMs })),
      'self',
    )) {
      out.push(line);
    }
    if (prof.functions.length > shown.length) {
      moreLine(prof.functions.length - shown.length);
    }
    // A signpost at the point of use, not a restatement: VERDICT's notes carry
    // the full caveat, and this table is where the reader is misled by it.
    if (v.anonBlindspot) {
      const b = v.anonBlindspot;
      out.push(
        `  ${c.yellow(
          `${ms0(b.selfMs)} (${pct0(b.sharePct)}) of this is in (anonymous) rows — ` +
            `this ranking is under-reporting; read FILES below.`,
        )}`,
      );
    }
  }

  // ── FILES — the same self-time by source file: which subsystem is hot. ────
  if (prof && prof.files.app.length + prof.files.dep.length > 0) {
    blank();
    heading('FILES', 'self-time by source file');
    out.push(
      `  ${ms0(prof.appMs)} app code ${c.dim(`(${pct0(prof.appSharePct)})`)} · ` +
        `${ms0(prof.depMs)} dependencies ${c.dim(`(${pct0(prof.depSharePct)})`)} ` +
        c.dim(`· ${plural(prof.fileCount, 'file')}`),
    );

    // Two lists rather than one merged ranking: "which of my files" and "which
    // dependency" are separate decisions, and a merged list buries app files
    // under engine chunks exactly when the engine dominates. `app` is the same
    // first-party test the APP tag uses — on a fully bundled production build
    // it can't separate vendor code, so read the split as a hint, not a fact.
    const groups: [group: typeof prof.files.app, label: string][] = [
      [prof.files.app, 'app code — first-party by source path'],
      [prof.files.dep, 'dependencies — engine/library code; the lever is fewer calls in'],
    ];
    for (const [group, label] of groups) {
      if (group.length === 0) continue;
      const shown = debug ? group : group.slice(0, 10);
      blank();
      out.push(`  ${c.dim(label)}`);
      for (const line of ranked(
        c,
        shown.map((fl) => ({
          metricMs: fl.selfMs,
          secondary: pct1(fl.sharePct),
          name: shortenUrl(fl.url),
          trailing: spread(fl),
        })),
        { metric: 'self', secondary: 'share', name: 'file', trailing: 'spread' },
      )) {
        out.push(line);
      }
      if (group.length > shown.length) moreLine(group.length - shown.length);
    }
  }

  // ── Debug-only diagnostics. ───────────────────────────────────────────────
  if (debug && f.droppedClusters.length > 0) {
    blank();
    out.push(`  ${c.dim('dropped-frame clusters')}`);
    for (const cl of f.droppedClusters) {
      out.push(
        `  ${c.dim(`${secs(cl.startMs)}–${secs(cl.endMs)}  ${cl.count} frame(s)`)}`,
      );
    }
  }
  if (debug) {
    blank();
    out.push(c.dim(`scanned in ${(elapsedMs / 1000).toFixed(1)}s`));
  }

  return out.join('\n');
}
