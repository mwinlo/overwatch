# Overwatch

Local monitoring dashboard for Claude Code sessions on macOS. See which sessions are eating your RAM and kill them before your Mac locks up.

When you run multiple Claude Code sessions simultaneously, each one consumes significant memory and CPU. Overwatch gives you a single mission-control view of all active sessions so you can spot runaway processes and terminate them before your system grinds to a halt.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open [http://localhost:4040](http://localhost:4040)

## What You See

### System Health Strip

Five cards across the top showing real-time system-wide metrics:

- **RAM Usage** — Total used vs total available, with a color-coded progress bar (green < 70%, amber 70-85%, red > 85%)
- **Claude RAM** — How much of your system RAM is consumed by Claude Code sessions specifically
- **CPU Load** — 1-minute load average normalized to your core count
- **Sessions** — Count of active Claude Code CLI processes
- **Total Tokens** — Aggregate input/output tokens and estimated cost across all sessions

### Historical Charts

Two time-series charts showing the last 20 minutes of data:

- **Memory Over Time** — Stacked area chart with one layer per session, plus a dashed red line showing your total RAM ceiling
- **CPU Over Time** — Line chart with one line per session, plus a dotted reference line at 100% (one full core)

### Session Cards

One card per active Claude Code session, with a sort toggle (oldest first or by memory). Each card shows:

- **Status dot** — Green (< 2 GB), amber (2-4 GB), red (> 4 GB)
- **Project label** — Derived from the session's working directory
- **PID** — Process ID
- **Memory** — Total tree RSS (the session process plus all its child processes)
- **CPU** — Current CPU percentage
- **Threads / Children** — Thread count and spawned subprocess count
- **Uptime** — How long the session has been running
- **Token estimates** — Input/output token counts and approximate cost, parsed from Claude's conversation logs
- **Kill button** — Two-click confirmation: first click shows "Confirm Kill?", second click sends SIGTERM (then SIGKILL after 2 seconds if needed)

When no Claude Code sessions are running, an empty state message is shown instead.

### Alert System

Overwatch has a layered alert system that catches dangerous memory growth at every speed:

| Alert | Trigger | Speed | Level | Visual |
|-------|---------|-------|-------|--------|
| `ram_spike` | Single poll >0.5 GB/s | ~3s | Critical | Red pulsing card border |
| `ram_burst` | 3-poll avg >0.2 GB/s | ~9s | Critical | Red pulsing card + **BURST** badge |
| `ram_runaway` | Projected ceiling hit <2min | ~15s | Warning | Amber pulsing card + **CEILING IN Xs** countdown |
| `ram_ceiling` | Session at ≥80% of total RAM | 3s | Critical | Auto-kill fires |
| `low_ram` | System available RAM <2 GB | 3s | Warning | Fast polling activated |
| `session_exited` | Session disappeared between polls | 3s | Warning | Amber banner + tombstone card (30s) |

When any critical or burst alert fires, an alert banner appears at the top of the dashboard. Runaway and exit alerts show an amber banner. All alert types (spike, burst, runaway) trigger fast polling at 500ms.

**Session exit detection** — When a session dies or is killed, a fading tombstone card shows its last-known metrics (memory, uptime) with an "EXITED" badge for 30 seconds, so you always know what happened.

**Runaway projection** — Tracks each session's memory over a 30-second sliding window (10 polls). If the average growth rate projects a ceiling breach within 2 minutes, the card shows a live countdown badge.

**Burst detection** — Catches the middle ground between single-poll spikes and long-term runaway: if the average growth rate over 3 polls exceeds 0.2 GB/s, a critical burst alert fires immediately.

### RAM Protection

When a session's tree memory exceeds the RAM ceiling (default 80% of total RAM), Overwatch auto-kills it:

1. Sends `SIGTERM` to the session PID
2. Waits 2 seconds
3. Sends `SIGKILL` if the process is still alive

Auto-killed sessions are logged to the console and shown as exited tombstone cards on the dashboard.

### Adaptive Polling

Normal polling runs every 3 seconds. Under pressure (low system RAM, spike, burst, or runaway detected), polling accelerates to 500ms for faster response. It returns to 3 seconds when conditions normalize.

### Connection Status

- A pulsing green dot in the header indicates a live WebSocket connection
- If the connection drops, a red banner appears and the dot turns grey; reconnection is automatic every 3 seconds

## How It Works

### Architecture

```
Browser (index.html)  <──WebSocket──>  server.js  ──calls──>  monitor.js
                                           │                      │
                                      Express:4040          macOS commands:
                                      POST /api/kill/:pid     ps, vm_stat,
                                           │                  sysctl, lsof
                                      alerts.js
                                        detectAlerts()
                                        detectBurst()
                                        detectRunaway()
```

### Metrics Collection (`monitor.js`)

Every 3 seconds, the server calls `collectAll()` which:

1. **System metrics** — Runs `vm_stat` to get memory page counts, `sysctl hw.memsize` for total RAM, `sysctl hw.ncpu` for core count, and `sysctl vm.loadavg` for CPU load. Active + wired pages are counted as "used" RAM.

2. **Session discovery** — Runs `ps -eo pid,ppid,rss,%cpu,etime,command` and filters for processes whose command is `claude` (excluding `Claude.app`, `Claude Helper`, and `claude_crashpad`). For each session, it builds a process tree by tracing parent-child PID relationships to include spawned subprocesses.

3. **Per-session metrics** — For each discovered session:
   - **Working directory** via `lsof -a -p <PID> -d cwd`
   - **Thread count** via `ps -M <PID>`
   - **Tree memory** — Sum of RSS across the session PID and all descendant processes
   - **Token estimation** — Reads JSONL conversation logs from `~/.claude/projects/<path-slug>/` and sums `input_tokens` and `output_tokens` from assistant message usage metadata. Cost is estimated at $3/MTok input and $15/MTok output.

All system commands run without sudo. If any individual metric fails (e.g., `lsof` lacking permissions), that metric is silently skipped and shown as "—" in the UI.

### Alert Detection (`alerts.js`)

Three pure functions, extracted for testability:

- **`detectAlerts(current, prev, opts)`** — Compares two consecutive snapshots. Detects single-poll RAM spikes, ceiling breaches, low system RAM, and session exits.
- **`detectBurst(current, growthTracker, opts)`** — Checks a short window (last 3 samples) for averaged growth exceeding the burst threshold. Fires critical alert before runaway can accumulate enough samples.
- **`detectRunaway(current, growthTracker, opts)`** — Checks a longer window (10 samples, ~30s) and projects time-to-ceiling based on average growth rate. Fires warning when breach is projected within the horizon.

### Server (`server.js`)

- **Express** serves the `public/` directory as static files
- **WebSocket** broadcasts the full metrics payload (including alerts and exited session tombstones) to all connected browsers every 3 seconds
- **History buffer** stores the last 400 data points (20 minutes at 3-second intervals) in memory for the time-series charts
- **Growth tracker** maintains a per-session rolling window of memory samples (last 10 polls) for burst and runaway detection
- **Exited session tracker** keeps tombstone data for recently exited sessions (30-second TTL)
- **Kill endpoint** (`POST /api/kill/:pid`) validates the PID belongs to a Claude CLI process, sends SIGTERM, waits 2 seconds, then sends SIGKILL if the process is still alive
- **Auto-kill** terminates any session exceeding the RAM ceiling on each poll cycle

### Frontend (`public/index.html`)

A single HTML file with inlined CSS and JavaScript — no build step, no framework. Uses:

- **Chart.js** (from CDN) for the time-series charts
- **JetBrains Mono** and **IBM Plex Sans** (from Google Fonts) for the mission-control aesthetic
- **WebSocket** for real-time updates with automatic reconnection

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4040` | Server port |
| `OW_RAM_CEILING_PCT` | `80` | Auto-kill session above this % of total RAM |
| `OW_RAM_SPIKE_GB_S` | `0.5` | Single-poll spike threshold (GB/s) |
| `OW_RAM_PRESSURE_GB` | `2` | Switch to fast polling when available RAM drops below this (GB) |
| `OW_RUNAWAY_HORIZON_SEC` | `120` | Runaway alert fires when ceiling is projected within this many seconds |
| `OW_BURST_GB_S` | `0.2` | Burst alert threshold — avg growth rate over 3 polls (GB/s) |

## Testing

```bash
npm test
```

Runs 45 tests covering:
- Alert detection: spike, burst, runaway, ceiling, low RAM, session exit
- Burst detection: threshold, minimum samples, flat/shrinking memory, windowing
- Runaway detection: ceiling projection, slow growth, shrinking, minimum samples, annotation
- Parsing utilities for `vm_stat`, `ps`, and load average output
- Process tree building and descendant discovery
- System metrics collection (live smoke tests)
- HTTP static serving and kill endpoint validation
- WebSocket connection and initial payload delivery

## Notes

- **macOS only** — uses `ps`, `vm_stat`, `sysctl`, and `lsof` which are macOS-specific
- **Apple Silicon + Intel** — works on both; metrics commands are the same
- **Full Disk Access** may be needed in System Settings > Privacy & Security for `lsof` to read working directories of some processes
- **Token counts and cost estimates are approximate** — based on parsing conversation log files; not all token data may be available
- **No authentication** — designed for local use only, not exposed to the network
- **No persistence** — all data is in-memory; history resets when the server restarts
