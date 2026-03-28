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

Four cards across the top showing real-time system-wide metrics:

- **RAM Usage** — Total used vs total available, with a color-coded progress bar (green < 70%, amber 70-85%, red > 85%)
- **Claude RAM** — How much of your system RAM is consumed by Claude Code sessions specifically
- **CPU Load** — 1-minute load average normalized to your core count
- **Sessions** — Count of active Claude Code CLI processes

### Historical Charts

Two time-series charts showing the last 20 minutes of data:

- **Memory Over Time** — Stacked area chart with one layer per session, plus a dashed red line showing your total RAM ceiling
- **CPU Over Time** — Line chart with one line per session, plus a dotted reference line at 100% (one full core)

### Session Cards

One card per active Claude Code session, sorted by memory usage (highest first). Each card shows:

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
                                                              sysctl, lsof
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

### Server (`server.js`)

- **Express** serves the `public/` directory as static files
- **WebSocket** broadcasts the full metrics payload to all connected browsers every 3 seconds
- **History buffer** stores the last 400 data points (20 minutes at 3-second intervals) in memory for the time-series charts
- **Kill endpoint** (`POST /api/kill/:pid`) validates the PID belongs to a Claude CLI process, sends SIGTERM, waits 2 seconds, then sends SIGKILL if the process is still alive

### Frontend (`public/index.html`)

A single HTML file with inlined CSS and JavaScript — no build step, no framework. Uses:

- **Chart.js** (from CDN) for the time-series charts
- **JetBrains Mono** and **IBM Plex Sans** (from Google Fonts) for the mission-control aesthetic
- **WebSocket** for real-time updates with automatic reconnection

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `4040`  | Server port |

## Testing

```bash
npm test
```

Runs 21 tests covering:
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
