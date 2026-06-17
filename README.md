# perftale

Performance optimizing web apps can be painful. Instead of staring at flame charts, download the (Chrome) performance trace and run it through perftale. It turns the mostly-noise trace into high signal insights. It is designed for use with web games, and has dedicated React support, but would be useful for any interaction or animation-heavy app.

## Installation

Requires Node 23.6+ (runs TypeScript natively, no build step) and pnpm.

```bash
pnpm install
```

Optionally, there is an `install.sh` script that symlinks the `perftale` command into `~/.local/bin` and the repo into your Claude skills directory. See [Using as a Claude skill](#using-as-a-claude-skill) for flags and details.

## Usage

Record a performance trace in Chrome DevTools and export it as JSON, then:

```bash
perftale <trace.json[.gz]>
```

Options:

- `--fps <n>` — override the auto-detected refresh rate
- `--debug` — include pipeline diagnostics (noise reduction, latency, dropped-frame clusters)
- `--out <path>` — write the structured summary JSON to `<path>`
- `--json` — write the summary JSON to `.perftale/<trace>.summary.json`

Example:

```bash
perftale ./my-trace.json.gz --json
```

Working in a clone without the global install? `pnpm analyze <trace>` runs the same thing.

## Using as a Claude skill

perftale ships with a [`SKILL.md`](SKILL.md) that teaches [Claude Code](https://claude.com/claude-code)
when and how to run it. [`./install.sh`](install.sh) (run during [Installation](#installation))
registers it by symlinking the repo into `~/.claude/skills/perftale`, so Claude
discovers `SKILL.md` and the CLI together. The CLI imports this repo's `src/` and
`node_modules`, so the `perftale` command always symlinks back to the clone — it
can't run detached. Re-running the installer is safe: correct symlinks are left
alone, and anything it replaces is backed up.

Flags:

- `--copy` — copy `SKILL.md` into a standalone skill dir instead of symlinking the
  repo (the global command stays a symlink; the CLI can't run detached).
- `BIN_DIR=~/bin ./install.sh` — link the `perftale` command somewhere other than
  `~/.local/bin` (must be on your `PATH`).

To pre-approve the analyzer so the skill runs without a permission prompt, merge
[`permissions.json`](permissions.json) into `~/.claude/settings.json` under
`permissions.allow`. Restart Claude Code afterward so the new skill is discovered.

Once installed, drop a trace into your project (or give Claude its path) and ask
something like "analyze this trace" or "why is this janky" — the skill triggers
automatically, runs the analysis, and reads the summary back to find and fix the jank.

## Output format

Running with `--json` (or `--out <path>`) writes a structured summary to
`.perftale/<trace>.summary.json` — a compact, timestamp-free digest meant to be read by an agent or diffed across runs.

The full output shape is declared as a single TypeScript type in
[`src/summary-schema.ts`](src/summary-schema.ts) (the `Summary` interface, versioned by `SUMMARY_SCHEMA_VERSION`). Top-level keys:

| key             | meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `schemaVersion` | artifact schema version; bumps on any shape change                           |
| `trace`         | source trace filename                                                        |
| `verdict`       | the conclusion — headline, what the frame is bound by, top hotspot, caveats  |
| `frames`        | refresh rate, dropped frames, freezes, and where main-thread frame time goes |
| `profile`       | JS self-time hotspots by function (`null` if the trace has no CPU profile)   |
| `tasks`         | long main-thread tasks (>50ms)                                               |
| `gc`            | GC pause pressure and suspected allocators (`null` if no v8.gc data)         |
| `react`         | component-render digest from React DevTools timing (`null` if absent)        |
| `size`          | noise-reduction stats for the streaming pass (debug only)                    |
