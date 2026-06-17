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
 *   - every ranked list (JS, GC suspects, React, frame-time breakdown) shares one
 *     column layout with a dim header row, so they read the same way.
 *
 * Colour is subtle and only ever carries meaning (green = good / app code,
 * yellow·red = a problem, dim = units / locations / metadata, bold = structure)
 * and is disabled automatically when the output isn't a TTY (see `bin/perftale`).
 */
import pc from 'picocolors';
import type { Analysis } from './analyze.ts';

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
  /** `file:line`, dim; omit for tables without a location column. */
  location?: string;
}

/**
 * The one ranked-list renderer every numeric table flows through, so the JS,
 * GC-suspect, React, and frame-time tables all align and read identically.
 */
function ranked(
  c: Colors,
  rows: Ranked[],
  headers: { metric: string; secondary: string; name: string },
): string[] {
  const metricStrs = rows.map((r) => ms1(r.metricMs));
  const metricW = Math.max(headers.metric.length, ...metricStrs.map((s) => s.length));
  const secW = Math.max(headers.secondary.length, ...rows.map((r) => r.secondary.length));
  const hasApp = rows.some((r) => r.app !== undefined);
  const hasLoc = rows.some((r) => r.location !== undefined);
  const nameW = Math.min(
    34,
    Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
  );

  const head: string[] = [
    headers.metric.padStart(metricW),
    headers.secondary.padStart(secW),
  ];
  if (hasApp) head.push('   ');
  head.push(hasLoc ? headers.name.padEnd(nameW) : headers.name);
  if (hasLoc) head.push('location');

  const lines = [`  ${c.dim(head.join('  '))}`];
  rows.forEach((r, i) => {
    const cells: string[] = [
      (metricStrs[i] ?? '').padStart(metricW),
      r.secondary.padStart(secW),
    ];
    if (hasApp) cells.push(r.app ? c.green('APP') : '   ');
    cells.push(hasLoc ? r.name.padEnd(nameW) : r.name);
    if (hasLoc && r.location) cells.push(c.dim(r.location));
    lines.push(`  ${cells.join('  ')}`);
  });
  return lines;
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
      `${c.green(h.functionName)}  ${c.dim(`${shortenUrl(h.url)}:${h.line}`)} ` +
        `${c.dim(`· ${ms0(h.selfMs)} self`)}`,
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
        const loc = `${shortenUrl(h.url)}:${h.line}`;
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
      for (const line of ranked(
        c,
        shown.map((s) => ({
          metricMs: s.selfMs,
          secondary: pct0(s.sharePct),
          app: s.app,
          name: s.functionName,
          location: `${shortenUrl(s.url)}:${s.line}`,
        })),
        { metric: 'run-up', secondary: 'share', name: 'function' },
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
      for (const line of ranked(
        c,
        shown.map((s) => ({
          metricMs: s.preGcMs,
          secondary: pct0(s.sharePct),
          app: s.app,
          name: s.functionName,
          location: `${shortenUrl(s.url)}:${s.line}`,
        })),
        { metric: 'pre-gc', secondary: 'share', name: 'function' },
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
    for (const line of ranked(
      c,
      shown.map((fn) => ({
        metricMs: fn.selfMs,
        secondary: pct0(fn.sharePct),
        app: fn.app,
        name: fn.functionName,
        location: `${shortenUrl(fn.url)}:${fn.line}`,
      })),
      { metric: 'self', secondary: 'share', name: 'function' },
    )) {
      out.push(line);
    }
    if (prof.functions.length > shown.length) {
      moreLine(prof.functions.length - shown.length);
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
