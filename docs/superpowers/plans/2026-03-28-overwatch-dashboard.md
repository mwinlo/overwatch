# Overwatch Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local macOS monitoring dashboard that shows all running Claude Code sessions, their resource usage, and lets you kill runaway ones before they crash your Mac.

**Architecture:** Node.js Express server on port 4040 serves a single-page vanilla HTML dashboard. A `monitor.js` module polls macOS `ps`, `vm_stat`, `sysctl`, and `lsof` every 3 seconds to collect system and per-session metrics. Results broadcast to all browser clients via WebSocket. A 20-minute rolling buffer of snapshots powers Chart.js time-series graphs. A kill endpoint sends SIGTERM/SIGKILL to selected PIDs.

**Tech Stack:** Node.js, Express, ws (WebSocket), Chart.js (CDN), vanilla HTML/CSS/JS. No build step, no TypeScript, no framework.

---

## File Structure

```
overwatch/
├── server.js            # Express + WebSocket server, polling loop, kill endpoint, history buffer
├── monitor.js           # Pure parsing functions + system command wrappers for metrics collection
├── public/
│   └── index.html       # Single-file dashboard (HTML + CSS + JS inlined)
├── test/
│   ├── monitor.test.js  # Unit tests for all parsing/collection functions
│   └── server.test.js   # Integration tests for HTTP + WebSocket endpoints
├── package.json         # Dependencies: express, ws. Dev: none.
└── README.md            # Setup and usage docs
```

**Responsibilities:**
- `monitor.js` — Owns all system interaction. Exports pure parsing functions (testable with fixture strings) and collection functions that call `execSync` internally. Never touches HTTP or WebSocket.
- `server.js` — Owns HTTP serving, WebSocket broadcasting, polling interval, rolling history buffer, and kill endpoint. Imports only `collectAll()` from monitor.js.
- `public/index.html` — Owns all rendering. Connects to WebSocket, receives JSON payloads, renders system health strip, Chart.js charts, and session cards. Handles kill button confirmation UX and reconnection banner.

**Security note:** All `execSync` calls in monitor.js use hardcoded command strings or validated integer PIDs (from `parseInt`). No user-supplied strings are interpolated into shell commands. The kill endpoint validates that the target PID belongs to a Claude CLI process before sending signals.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `server.js` (placeholder)
- Create: `monitor.js` (placeholder)
- Create: `public/index.html` (placeholder)
- Create: `test/monitor.test.js` (placeholder)
- Create: `test/server.test.js` (placeholder)

- [ ] **Step 1: Initialize the project**

```bash
cd /Users/apollo/Documents/Overwatch
git init
```

- [ ] **Step 2: Create package.json**

Create `package.json`:

```json
{
  "name": "overwatch",
  "version": "1.0.0",
  "description": "Local monitoring dashboard for Claude Code sessions on macOS",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "keywords": [],
  "license": "MIT",
  "dependencies": {
    "express": "^4.21.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 3: Create placeholder files**

Create `monitor.js`:
```js
// Process discovery and metrics collection for macOS
module.exports = {};
```

Create `server.js`:
```js
// Express + WebSocket server
```

Create `public/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Overwatch</title></head>
<body><h1>Overwatch</h1></body>
</html>
```

Create `test/monitor.test.js`:
```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('monitor', () => {
  it('placeholder', () => {
    assert.ok(true);
  });
});
```

Create `test/server.test.js`:
```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('server', () => {
  it('placeholder', () => {
    assert.ok(true);
  });
});
```

- [ ] **Step 4: Install dependencies and run tests**

```bash
npm install
npm test
```

Expected: Both test files pass with placeholder tests. `node_modules/` created.

- [ ] **Step 5: Create .gitignore and commit**

Create `.gitignore`:
```
node_modules/
```

```bash
git add package.json package-lock.json .gitignore monitor.js server.js public/index.html test/monitor.test.js test/server.test.js
git commit -m "chore: scaffold overwatch project"
```

---

## Task 2: monitor.js — Parsing Utilities and System Metrics

**Files:**
- Modify: `monitor.js`
- Modify: `test/monitor.test.js`

This task implements the pure parsing functions and the `getSystemMetrics()` function. All parsers accept string input so they are testable without running actual system commands.

- [ ] **Step 1: Write failing tests for parseVmStat**

Replace `test/monitor.test.js` with:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseVmStat, parseLoadAvg, parsePsOutput } = require('../monitor');

describe('parseVmStat', () => {
  const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                2678.
Pages active:                            281858.
Pages inactive:                          280408.
Pages speculative:                          280.
Pages throttled:                              0.
Pages wired down:                        133475.
Pages purgeable:                              0.
"Translation faults":                  34472525.
Pages copy-on-write:                     307813.`;

  it('extracts page size from header', () => {
    const result = parseVmStat(SAMPLE);
    assert.equal(result.pageSize, 16384);
  });

  it('extracts page counts', () => {
    const result = parseVmStat(SAMPLE);
    assert.equal(result.free, 2678);
    assert.equal(result.active, 281858);
    assert.equal(result.inactive, 280408);
    assert.equal(result.wired, 133475);
  });

  it('defaults page size to 16384 if header is malformed', () => {
    const result = parseVmStat('Some weird header\nPages free: 100.');
    assert.equal(result.pageSize, 16384);
    assert.equal(result.free, 100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `parseVmStat is not a function` (not yet exported).

- [ ] **Step 3: Implement parseVmStat**

Replace `monitor.js` with:

```js
const { execSync } = require('child_process');

/**
 * Parse macOS vm_stat output into page counts.
 */
function parseVmStat(output) {
  const lines = output.trim().split('\n');
  const pageSizeMatch = lines[0].match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 16384;

  const stats = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^(.+?):\s+(\d+)/);
    if (match) {
      stats[match[1].trim().toLowerCase()] = parseInt(match[2]);
    }
  }

  return {
    pageSize,
    free: stats['pages free'] || 0,
    active: stats['pages active'] || 0,
    inactive: stats['pages inactive'] || 0,
    speculative: stats['pages speculative'] || 0,
    wired: stats['pages wired down'] || 0,
  };
}

module.exports = { parseVmStat };
```

- [ ] **Step 4: Run test to verify parseVmStat passes**

```bash
npm test
```

Expected: All 3 parseVmStat tests PASS.

- [ ] **Step 5: Write failing tests for parseLoadAvg**

Add to `test/monitor.test.js` (after the parseVmStat describe block):

```js
describe('parseLoadAvg', () => {
  it('extracts three load averages', () => {
    const result = parseLoadAvg('{ 2.90 6.62 5.54 }');
    assert.equal(result.load1m, 2.9);
    assert.equal(result.load5m, 6.62);
    assert.equal(result.load15m, 5.54);
  });

  it('returns zeros for unparseable input', () => {
    const result = parseLoadAvg('garbage');
    assert.equal(result.load1m, 0);
    assert.equal(result.load5m, 0);
    assert.equal(result.load15m, 0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `parseLoadAvg is not a function`.

- [ ] **Step 7: Implement parseLoadAvg and export**

Add to `monitor.js` (before `module.exports`):

```js
/**
 * Parse macOS sysctl -n vm.loadavg output.
 */
function parseLoadAvg(output) {
  const match = output.match(/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/);
  if (!match) return { load1m: 0, load5m: 0, load15m: 0 };
  return {
    load1m: parseFloat(match[1]),
    load5m: parseFloat(match[2]),
    load15m: parseFloat(match[3]),
  };
}
```

Update exports: `module.exports = { parseVmStat, parseLoadAvg };`

- [ ] **Step 8: Run test to verify parseLoadAvg passes**

```bash
npm test
```

Expected: All 5 tests PASS.

- [ ] **Step 9: Write failing tests for parsePsOutput**

Add to `test/monitor.test.js`:

```js
describe('parsePsOutput', () => {
  const SAMPLE = `  PID  PPID      RSS  %CPU     ELAPSED COMMAND
 1745   735   328256  12.5    06:12:00 claude
 1356   740   299776   8.7    07:47:00 claude
 2001  1745    12288   0.5    00:30:00 /bin/bash
 2002  2001     4096   0.1    00:15:00 grep something`;

  it('parses all rows skipping header', () => {
    const result = parsePsOutput(SAMPLE);
    assert.equal(result.length, 4);
  });

  it('extracts pid, ppid, rssKB, cpuPercent, elapsed, command', () => {
    const result = parsePsOutput(SAMPLE);
    assert.deepEqual(result[0], {
      pid: 1745,
      ppid: 735,
      rssKB: 328256,
      cpuPercent: 12.5,
      elapsed: '06:12:00',
      command: 'claude',
    });
  });

  it('handles commands with spaces and arguments', () => {
    const result = parsePsOutput(SAMPLE);
    assert.equal(result[3].command, 'grep something');
  });

  it('returns empty array for empty input', () => {
    const result = parsePsOutput('');
    assert.deepEqual(result, []);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `parsePsOutput is not a function`.

- [ ] **Step 11: Implement parsePsOutput and export**

Add to `monitor.js`:

```js
/**
 * Parse ps -eo pid,ppid,rss,%cpu,etime,command output.
 */
function parsePsOutput(output) {
  const lines = output.trim().split('\n');
  if (lines.length <= 1) return [];

  return lines.slice(1).map(line => {
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) return null;
    return {
      pid: parseInt(parts[0]),
      ppid: parseInt(parts[1]),
      rssKB: parseInt(parts[2]),
      cpuPercent: parseFloat(parts[3]),
      elapsed: parts[4],
      command: parts.slice(5).join(' '),
    };
  }).filter(p => p && !isNaN(p.pid));
}
```

Update exports: `module.exports = { parseVmStat, parseLoadAvg, parsePsOutput };`

- [ ] **Step 12: Run test to verify parsePsOutput passes**

```bash
npm test
```

Expected: All 9 tests PASS.

- [ ] **Step 13: Implement getSystemMetrics**

Add to `monitor.js`:

```js
/**
 * Collect system-wide metrics by calling macOS commands.
 */
function getSystemMetrics() {
  const totalBytes = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim());
  const totalRamGB = Math.round((totalBytes / 1073741824) * 10) / 10;

  const vmStatOutput = execSync('vm_stat', { encoding: 'utf8' });
  const vm = parseVmStat(vmStatOutput);
  const usedPages = vm.active + vm.wired;
  const usedRamGB = Math.round((usedPages * vm.pageSize / 1073741824) * 10) / 10;
  const availableRamGB = Math.round((totalRamGB - usedRamGB) * 10) / 10;

  const cpuCores = parseInt(execSync('sysctl -n hw.ncpu', { encoding: 'utf8' }).trim());
  const loadOutput = execSync('sysctl -n vm.loadavg', { encoding: 'utf8' });
  const load = parseLoadAvg(loadOutput);
  const cpuLoadPercent = Math.round((load.load1m / cpuCores) * 100);

  return {
    totalRamGB,
    usedRamGB,
    availableRamGB,
    claudeRamGB: 0, // filled in by collectAll after session data is available
    cpuLoadAvg1m: load.load1m,
    cpuCores,
    cpuLoadPercent,
  };
}
```

Update exports: `module.exports = { parseVmStat, parseLoadAvg, parsePsOutput, getSystemMetrics };`

- [ ] **Step 14: Write a smoke test for getSystemMetrics**

Add to `test/monitor.test.js`:

```js
const { getSystemMetrics } = require('../monitor');

describe('getSystemMetrics', () => {
  it('returns system metrics with expected shape', () => {
    const result = getSystemMetrics();
    assert.equal(typeof result.totalRamGB, 'number');
    assert.equal(typeof result.usedRamGB, 'number');
    assert.equal(typeof result.availableRamGB, 'number');
    assert.equal(typeof result.cpuCores, 'number');
    assert.equal(typeof result.cpuLoadPercent, 'number');
    assert.ok(result.totalRamGB > 0, 'totalRamGB should be > 0');
    assert.ok(result.cpuCores > 0, 'cpuCores should be > 0');
  });
});
```

- [ ] **Step 15: Run all tests**

```bash
npm test
```

Expected: All 10 tests PASS.

- [ ] **Step 16: Commit**

```bash
git add monitor.js test/monitor.test.js
git commit -m "feat: add parsing utilities and system metrics collection"
```

---

## Task 3: monitor.js — Process Discovery and collectAll

**Files:**
- Modify: `monitor.js`
- Modify: `test/monitor.test.js`

This task adds Claude session discovery (process tree building, working directory lookup, thread counts, token estimation) and the top-level `collectAll()` function.

- [ ] **Step 1: Write failing tests for buildProcessTree**

Add to `test/monitor.test.js`:

```js
const { buildProcessTree } = require('../monitor');

describe('buildProcessTree', () => {
  const processes = [
    { pid: 100, ppid: 1, rssKB: 300000, cpuPercent: 10, elapsed: '01:00:00', command: 'claude' },
    { pid: 200, ppid: 100, rssKB: 10000, cpuPercent: 1, elapsed: '00:30:00', command: '/bin/bash' },
    { pid: 300, ppid: 200, rssKB: 5000, cpuPercent: 0.5, elapsed: '00:10:00', command: 'grep foo' },
    { pid: 400, ppid: 1, rssKB: 250000, cpuPercent: 8, elapsed: '02:00:00', command: 'claude' },
    { pid: 500, ppid: 2, rssKB: 1000, cpuPercent: 0, elapsed: '05:00:00', command: 'unrelated' },
  ];

  it('groups descendants under root PIDs', () => {
    const trees = buildProcessTree(processes, [100, 400]);
    assert.equal(trees.length, 2);
  });

  it('finds all descendants recursively', () => {
    const trees = buildProcessTree(processes, [100, 400]);
    const tree100 = trees.find(t => t.process.pid === 100);
    assert.equal(tree100.descendants.length, 2);
    assert.deepEqual(tree100.descendants.map(d => d.pid).sort(), [200, 300]);
  });

  it('returns empty descendants for leaf processes', () => {
    const trees = buildProcessTree(processes, [400]);
    assert.equal(trees[0].descendants.length, 0);
  });

  it('computes total tree RSS correctly', () => {
    const trees = buildProcessTree(processes, [100]);
    const treeRssKB = trees[0].process.rssKB + trees[0].descendants.reduce((s, d) => s + d.rssKB, 0);
    assert.equal(treeRssKB, 315000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `buildProcessTree is not a function`.

- [ ] **Step 3: Implement buildProcessTree**

Add to `monitor.js`:

```js
/**
 * Build process trees rooted at the given PIDs.
 */
function buildProcessTree(processes, rootPids) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const childrenOf = new Map();
  for (const p of processes) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p);
  }

  function getDescendants(pid) {
    const result = [];
    for (const child of (childrenOf.get(pid) || [])) {
      result.push(child);
      result.push(...getDescendants(child.pid));
    }
    return result;
  }

  return rootPids
    .filter(pid => byPid.has(pid))
    .map(pid => ({
      process: byPid.get(pid),
      descendants: getDescendants(pid),
    }));
}
```

Update exports to include `buildProcessTree`.

- [ ] **Step 4: Run test to verify buildProcessTree passes**

```bash
npm test
```

Expected: All 14 tests PASS.

- [ ] **Step 5: Implement getWorkingDir and getThreadCount helpers**

Add to `monitor.js` (internal helpers, not exported):

```js
/**
 * Get the current working directory of a process via lsof.
 */
function getWorkingDir(pid) {
  try {
    const output = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 3000,
    });
    const nLine = output.split('\n').find(l => l.startsWith('n') && l.length > 1);
    return nLine ? nLine.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * Get thread count for a process via ps -M.
 */
function getThreadCount(pid) {
  try {
    const output = execSync(`ps -M ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const lines = output.trim().split('\n');
    return Math.max(lines.length - 1, 1);
  } catch {
    return 1;
  }
}
```

- [ ] **Step 6: Implement getTokenInfo**

Add to `monitor.js` (add `path`, `fs`, `os` requires at the top of the file):

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Estimate token usage from Claude project JSONL files.
 */
function getTokenInfo(workingDir) {
  try {
    const slug = workingDir.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
    if (!fs.existsSync(projectDir)) return null;

    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    let messageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const file of files) {
      const content = fs.readFileSync(path.join(projectDir, file), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant') {
            messageCount++;
            const usage = obj.message?.usage;
            if (usage) {
              inputTokens += usage.input_tokens || 0;
              outputTokens += usage.output_tokens || 0;
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    const estimatedCostUSD = Math.round(((inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15) * 100) / 100;
    return { input: inputTokens, output: outputTokens, estimatedCostUSD, messageCount };
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Implement getClaudeSessions**

Add to `monitor.js`:

```js
/**
 * Discover all Claude Code CLI sessions and collect per-session metrics.
 */
function getClaudeSessions() {
  let psOutput;
  try {
    psOutput = execSync('ps -eo pid,ppid,rss,%cpu,etime,command', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }

  const allProcesses = parsePsOutput(psOutput);

  // Find Claude Code CLI processes (not Claude.app desktop)
  const claudeProcesses = allProcesses.filter(p => {
    const cmd = p.command;
    return (cmd === 'claude' || /\/claude(\s|$)/.test(cmd))
      && !cmd.includes('Claude.app')
      && !cmd.includes('claude_crashpad')
      && !cmd.includes('Claude Helper');
  });

  if (claudeProcesses.length === 0) return [];

  const claudePids = claudeProcesses.map(p => p.pid);
  const trees = buildProcessTree(allProcesses, claudePids);

  return trees.map(tree => {
    const proc = tree.process;
    const descendants = tree.descendants;
    const treeRssKB = proc.rssKB + descendants.reduce((sum, d) => sum + d.rssKB, 0);
    const workingDir = getWorkingDir(proc.pid);
    const label = workingDir ? path.basename(workingDir) : `pid-${proc.pid}`;
    const tokens = workingDir ? getTokenInfo(workingDir) : null;

    return {
      pid: proc.pid,
      workingDir: workingDir || 'unknown',
      label,
      rssGB: Math.round((proc.rssKB / 1048576) * 100) / 100,
      treeRssGB: Math.round((treeRssKB / 1048576) * 100) / 100,
      cpuPercent: proc.cpuPercent,
      threadCount: getThreadCount(proc.pid),
      childCount: descendants.length,
      elapsed: proc.elapsed,
      tokens: tokens || { input: 0, output: 0, estimatedCostUSD: 0, messageCount: 0 },
    };
  });
}
```

- [ ] **Step 8: Implement collectAll**

Add to `monitor.js`:

```js
/**
 * Collect all metrics: system-wide + per-session.
 * Returns the complete WebSocket payload object.
 */
function collectAll() {
  const system = getSystemMetrics();
  const sessions = getClaudeSessions();

  system.claudeRamGB = Math.round(sessions.reduce((sum, s) => sum + s.treeRssGB, 0) * 100) / 100;

  return {
    timestamp: new Date().toISOString(),
    system,
    sessions,
  };
}
```

Update exports:

```js
module.exports = {
  parseVmStat,
  parseLoadAvg,
  parsePsOutput,
  buildProcessTree,
  getSystemMetrics,
  getClaudeSessions,
  collectAll,
};
```

- [ ] **Step 9: Write smoke tests for getClaudeSessions and collectAll**

Add to `test/monitor.test.js`:

```js
const { getClaudeSessions, collectAll } = require('../monitor');

describe('getClaudeSessions', () => {
  it('returns an array', () => {
    const sessions = getClaudeSessions();
    assert.ok(Array.isArray(sessions));
  });

  it('each session has required fields', () => {
    const sessions = getClaudeSessions();
    for (const s of sessions) {
      assert.equal(typeof s.pid, 'number');
      assert.equal(typeof s.label, 'string');
      assert.equal(typeof s.rssGB, 'number');
      assert.equal(typeof s.treeRssGB, 'number');
      assert.equal(typeof s.cpuPercent, 'number');
      assert.equal(typeof s.elapsed, 'string');
      assert.ok(s.tokens && typeof s.tokens.messageCount === 'number');
    }
  });
});

describe('collectAll', () => {
  it('returns payload with timestamp, system, and sessions', () => {
    const payload = collectAll();
    assert.ok(payload.timestamp);
    assert.ok(payload.system);
    assert.ok(Array.isArray(payload.sessions));
    assert.equal(typeof payload.system.totalRamGB, 'number');
    assert.equal(typeof payload.system.claudeRamGB, 'number');
  });
});
```

- [ ] **Step 10: Run all tests**

```bash
npm test
```

Expected: All tests PASS (approximately 17 tests).

- [ ] **Step 11: Commit**

```bash
git add monitor.js test/monitor.test.js
git commit -m "feat: add Claude session discovery, token estimation, and collectAll"
```

---

## Task 4: server.js — Express Server, Kill Endpoint, and Static Files

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing test for HTTP server**

Replace `test/server.test.js` with:

```js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

describe('server HTTP', () => {
  let server;
  const PORT = 4041;

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('serves static files on GET /', async () => {
    const { createServer } = require('../server');
    server = await createServer(PORT);

    const res = await fetch(`http://localhost:${PORT}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('Overwatch'));
  });

  it('returns 400 for invalid PID on kill endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill/abc`, { method: 'POST' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('returns 404 for non-existent PID on kill endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill/999999`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `createServer` is not a function or module doesn't export it.

- [ ] **Step 3: Implement server.js**

Replace `server.js` with:

```js
const express = require('express');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_PORT = 4040;

/**
 * Create and start the Express HTTP server.
 * Exported as a factory so tests can use a different port.
 */
function createServer(port = DEFAULT_PORT) {
  const app = express();
  const server = http.createServer(app);

  app.use(express.static(path.join(__dirname, 'public')));

  // Kill endpoint: POST /api/kill/:pid
  app.post('/api/kill/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid PID' });

    // Verify process exists and is a Claude CLI process
    let command;
    try {
      command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 3000 }).trim();
    } catch {
      return res.status(404).json({ error: 'Process not found' });
    }

    if (!command.match(/claude/i) || command.includes('Claude.app')) {
      return res.status(403).json({ error: 'Not a Claude Code CLI process' });
    }

    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 0); // check if still alive
          process.kill(pid, 'SIGKILL');
        } catch {
          // already dead
        }
      }, 2000);
      res.json({ success: true, pid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return new Promise(resolve => {
    server.listen(port, () => resolve(server));
  });
}

// When run directly (not required by tests), start with full setup
if (require.main === module) {
  const port = parseInt(process.env.PORT) || DEFAULT_PORT;
  createServer(port).then(() => {
    console.log(`\u{1F52D} Overwatch running at http://localhost:${port}`);
  });
}

module.exports = { createServer };
```

- [ ] **Step 4: Run test to verify server tests pass**

```bash
npm test
```

Expected: All server tests PASS. Kill endpoint returns 400 for invalid PID, 404 for non-existent PID.

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: add Express server with static serving and kill endpoint"
```

---

## Task 5: server.js — WebSocket Broadcasting and Polling Loop

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing test for WebSocket connection**

Add to `test/server.test.js`:

```js
const WebSocket = require('ws');

describe('server WebSocket', () => {
  let server;
  const PORT = 4042;

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('accepts WebSocket connections and sends initial payload', async () => {
    const { createServer } = require('../server');
    server = await createServer(PORT);

    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const message = await new Promise((resolve, reject) => {
      ws.on('message', data => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for WS message')), 10000);
    });

    assert.ok(message.current, 'should have current field');
    assert.ok(Array.isArray(message.history), 'should have history array');
    assert.ok(message.current.system, 'current should have system');
    assert.ok(Array.isArray(message.current.sessions), 'current should have sessions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — WebSocket connection refused or no message received (WebSocket not set up yet).

- [ ] **Step 3: Add WebSocket and polling to server.js**

Replace `server.js` completely with the full version that includes WebSocket support:

```js
const express = require('express');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { collectAll } = require('./monitor');

const DEFAULT_PORT = 4040;
const POLL_INTERVAL_MS = 3000;
const MAX_HISTORY_POINTS = Math.floor((20 * 60 * 1000) / POLL_INTERVAL_MS); // 400 points = 20 minutes

function createServer(port = DEFAULT_PORT) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.static(path.join(__dirname, 'public')));

  // Kill endpoint
  app.post('/api/kill/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid PID' });

    let command;
    try {
      command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 3000 }).trim();
    } catch {
      return res.status(404).json({ error: 'Process not found' });
    }

    if (!command.match(/claude/i) || command.includes('Claude.app')) {
      return res.status(403).json({ error: 'Not a Claude Code CLI process' });
    }

    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 2000);
      res.json({ success: true, pid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rolling history buffer
  const history = [];

  // Collect initial snapshot
  try {
    history.push(collectAll());
  } catch (err) {
    console.error('Initial collection failed:', err.message);
  }

  // Poll every 3 seconds
  const pollInterval = setInterval(() => {
    try {
      const data = collectAll();
      history.push(data);
      if (history.length > MAX_HISTORY_POINTS) history.shift();

      const payload = JSON.stringify({ current: data, history });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // On new connection, send current state immediately
  wss.on('connection', ws => {
    const current = history.length > 0 ? history[history.length - 1] : collectAll();
    ws.send(JSON.stringify({ current, history }));
  });

  // Clean shutdown
  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(pollInterval);
    wss.close();
    originalClose(cb);
  };

  return new Promise(resolve => {
    server.listen(port, () => resolve(server));
  });
}

if (require.main === module) {
  const port = parseInt(process.env.PORT) || DEFAULT_PORT;
  createServer(port).then(() => {
    console.log(`\u{1F52D} Overwatch running at http://localhost:${port}`);
  });
}

module.exports = { createServer };
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: All tests PASS including WebSocket test receiving initial payload with `current` and `history`.

- [ ] **Step 5: Manual smoke test**

```bash
node server.js &
sleep 2
curl -s http://localhost:4040/ | head -5
kill %1
```

Expected: HTML content returned. Console shows startup message.

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: add WebSocket broadcasting and 3s polling loop with history buffer"
```

---

## Task 6: index.html — Shell, Styles, Connection and System Health Strip

**Files:**
- Modify: `public/index.html`

This is the largest task. It builds the complete HTML structure, all CSS, the WebSocket client connection logic, and the system health strip. Charts and session cards are stubs — implemented in Tasks 7 and 8.

- [ ] **Step 1: Create the full HTML shell with CSS and connection logic**

Replace `public/index.html` with the complete file. This is long but it is a single-file dashboard — all HTML, CSS, and JS live here.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Overwatch</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0e17;
      --surface: #111827;
      --border: rgba(255,255,255,0.06);
      --text: #e2e8f0;
      --text-secondary: #64748b;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
      --blue: #3b82f6;
      --kill-red: #dc2626;
      --font-mono: 'JetBrains Mono', monospace;
      --font-sans: 'IBM Plex Sans', sans-serif;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
    }

    /* Reconnection Banner */
    #reconnect-banner {
      display: none;
      background: var(--red);
      color: white;
      text-align: center;
      padding: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    #reconnect-banner.visible { display: block; }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header-title {
      font-family: var(--font-mono);
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 2px;
    }
    .pulse-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }
    .pulse-dot.disconnected { background: var(--text-secondary); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .header-right {
      display: flex; align-items: center; gap: 16px;
      font-size: 13px; color: var(--text-secondary); font-family: var(--font-mono);
    }
    .session-badge {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 4px 12px;
      font-weight: 600; color: var(--text);
    }

    /* System Health Strip */
    .health-strip {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 16px; padding: 20px 24px;
    }
    @media (max-width: 900px) { .health-strip { grid-template-columns: repeat(2, 1fr); } }
    .health-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 20px;
    }
    .health-card-label {
      font-size: 12px; font-weight: 500; color: var(--text-secondary);
      text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;
    }
    .health-card-value {
      font-family: var(--font-mono); font-size: 28px; font-weight: 700; margin-bottom: 4px;
    }
    .health-card-sub {
      font-size: 13px; color: var(--text-secondary); font-family: var(--font-mono);
    }
    .progress-bar {
      height: 4px; background: rgba(255,255,255,0.08);
      border-radius: 2px; margin-top: 10px; overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: 2px;
      transition: width 0.5s ease, background 0.5s ease;
    }

    /* Charts */
    .charts-row {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 16px; padding: 0 24px 20px;
    }
    @media (max-width: 900px) { .charts-row { grid-template-columns: 1fr; } }
    .chart-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 20px;
    }
    .chart-card h3 {
      font-family: var(--font-mono); font-size: 13px; font-weight: 600;
      color: var(--text-secondary); text-transform: uppercase;
      letter-spacing: 1px; margin-bottom: 12px;
    }

    /* Session Cards */
    .sessions-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 16px; padding: 0 24px 20px;
    }
    .session-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 20px; transition: opacity 0.5s ease;
    }
    .session-card.killing { opacity: 0.3; }
    .session-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;
    }
    .session-label {
      font-family: var(--font-mono); font-weight: 700; font-size: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .session-pid { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
    .session-path {
      font-size: 12px; color: var(--text-secondary);
      margin-bottom: 16px; word-break: break-all;
    }
    .session-metrics {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px 24px; margin-bottom: 16px;
    }
    .metric { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
    .metric-label { color: var(--text-secondary); }
    .metric-value { font-family: var(--font-mono); font-weight: 600; }
    .metric-bar { grid-column: 1 / -1; }
    .mini-bar {
      height: 3px; background: rgba(255,255,255,0.08);
      border-radius: 2px; margin-top: 4px; overflow: hidden;
    }
    .mini-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }
    .session-tokens {
      font-size: 12px; color: var(--text-secondary);
      font-family: var(--font-mono); margin-bottom: 16px; line-height: 1.6;
    }
    .kill-btn {
      background: var(--kill-red); color: white; border: none;
      border-radius: 6px; padding: 8px 16px;
      font-family: var(--font-mono); font-size: 13px; font-weight: 600;
      cursor: pointer; float: right; transition: box-shadow 0.2s ease;
    }
    .kill-btn:hover { box-shadow: 0 0 16px rgba(220, 38, 38, 0.4); }
    .kill-btn.confirming { background: #991b1b; }

    /* Empty State */
    .empty-state { text-align: center; padding: 80px 24px; color: var(--text-secondary); }
    .empty-state p { font-size: 16px; margin-bottom: 8px; }
    .empty-state code {
      font-family: var(--font-mono); background: var(--surface);
      padding: 2px 8px; border-radius: 4px;
    }

    /* Footer */
    .footer {
      text-align: center; padding: 16px;
      font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono);
    }
  </style>
</head>
<body>
  <div id="reconnect-banner">Connection lost - reconnecting...</div>

  <header class="header">
    <div class="header-left">
      <div class="pulse-dot" id="pulse-dot"></div>
      <span class="header-title">OVERWATCH</span>
    </div>
    <div class="header-right">
      <span id="last-updated">Connecting...</span>
      <span class="session-badge" id="session-count">0 sessions</span>
    </div>
  </header>

  <section class="health-strip">
    <div class="health-card">
      <div class="health-card-label">RAM Usage</div>
      <div class="health-card-value" id="ram-value">&mdash;</div>
      <div class="health-card-sub" id="ram-sub"></div>
      <div class="progress-bar"><div class="progress-fill" id="ram-bar"></div></div>
    </div>
    <div class="health-card">
      <div class="health-card-label">Claude RAM</div>
      <div class="health-card-value" id="claude-ram-value">&mdash;</div>
      <div class="health-card-sub" id="claude-ram-sub"></div>
    </div>
    <div class="health-card">
      <div class="health-card-label">CPU Load</div>
      <div class="health-card-value" id="cpu-value">&mdash;</div>
      <div class="health-card-sub" id="cpu-sub"></div>
    </div>
    <div class="health-card">
      <div class="health-card-label">Sessions</div>
      <div class="health-card-value" id="sessions-value">&mdash;</div>
      <div class="health-card-sub">active</div>
    </div>
  </section>

  <section class="charts-row">
    <div class="chart-card">
      <h3>Memory Over Time</h3>
      <canvas id="memory-chart" height="200"></canvas>
    </div>
    <div class="chart-card">
      <h3>CPU Over Time</h3>
      <canvas id="cpu-chart" height="200"></canvas>
    </div>
  </section>

  <section class="sessions-grid" id="sessions-grid"></section>

  <div class="empty-state" id="empty-state" style="display:none">
    <p>No Claude Code sessions detected.</p>
    <p>Start one in a terminal with <code>claude</code></p>
  </div>

  <footer class="footer">
    Polling every 3s &bull; Storing 20min history &bull; Port 4040
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    // ============================================================
    // STATE
    // ============================================================
    let ws = null;
    let reconnectTimer = null;

    // ============================================================
    // WEBSOCKET CONNECTION
    // ============================================================
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host);

      ws.onopen = function() {
        document.getElementById('reconnect-banner').classList.remove('visible');
        document.getElementById('pulse-dot').classList.remove('disconnected');
        if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
      };

      ws.onmessage = function(event) {
        var data = JSON.parse(event.data);
        updateDashboard(data);
      };

      ws.onclose = function() {
        document.getElementById('reconnect-banner').classList.add('visible');
        document.getElementById('pulse-dot').classList.add('disconnected');
        if (!reconnectTimer) {
          reconnectTimer = setInterval(function() { connect(); }, 3000);
        }
      };

      ws.onerror = function() { ws.close(); };
    }

    // ============================================================
    // SYSTEM HEALTH STRIP
    // ============================================================
    function updateHealthStrip(system, sessionCount) {
      var ramPct = Math.round((system.usedRamGB / system.totalRamGB) * 100);
      document.getElementById('ram-value').textContent = system.usedRamGB + ' / ' + system.totalRamGB + ' GB';
      document.getElementById('ram-sub').textContent = ramPct + '% used';
      var ramBar = document.getElementById('ram-bar');
      ramBar.style.width = ramPct + '%';
      ramBar.style.background = ramPct > 85 ? 'var(--red)' : ramPct > 70 ? 'var(--amber)' : 'var(--green)';

      var claudePct = system.totalRamGB > 0
        ? Math.round((system.claudeRamGB / system.totalRamGB) * 100) : 0;
      document.getElementById('claude-ram-value').textContent = system.claudeRamGB + ' GB';
      document.getElementById('claude-ram-sub').textContent = claudePct + '% of total';

      document.getElementById('cpu-value').textContent = system.cpuLoadPercent + '%';
      document.getElementById('cpu-sub').textContent = system.cpuLoadAvg1m + ' / ' + system.cpuCores + ' cores';

      document.getElementById('sessions-value').textContent = sessionCount;
      document.getElementById('session-count').textContent = sessionCount + ' session' + (sessionCount !== 1 ? 's' : '');

      document.getElementById('last-updated').textContent = 'Updated just now';
    }

    // ============================================================
    // DASHBOARD UPDATE (called on each WS message)
    // ============================================================
    function updateDashboard(data) {
      var current = data.current;
      var history = data.history;
      updateHealthStrip(current.system, current.sessions.length);
      updateCharts(history);
      renderSessionCards(current.sessions);
    }

    // Chart and session card stubs — implemented in Tasks 7 and 8
    function updateCharts(history) {}
    function renderSessionCards(sessions) {
      var grid = document.getElementById('sessions-grid');
      var emptyState = document.getElementById('empty-state');
      if (sessions.length === 0) {
        grid.innerHTML = '';
        emptyState.style.display = 'block';
      } else {
        emptyState.style.display = 'none';
      }
    }

    // ============================================================
    // INIT
    // ============================================================
    connect();
  </script>
</body>
</html>
```

- [ ] **Step 2: Manual test**

```bash
npm start &
sleep 2
open http://localhost:4040
```

Verify: dark background, OVERWATCH header with pulsing green dot, system health strip shows live values, empty state if no Claude CLI sessions running.

```bash
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add dashboard shell with CSS, WebSocket client, and system health strip"
```

---

## Task 7: index.html — Chart.js Charts

**Files:**
- Modify: `public/index.html`

Replace the `updateCharts` stub with real Chart.js implementations: a stacked area chart for memory and a line chart for CPU.

- [ ] **Step 1: Replace the updateCharts stub**

In `public/index.html`, find and replace the line:

```js
    function updateCharts(history) {}
```

with:

```js
    // ============================================================
    // CHARTS
    // ============================================================
    var SESSION_COLORS = [
      '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b',
      '#10b981', '#06b6d4', '#f43f5e', '#84cc16',
    ];
    var memoryChart = null;
    var cpuChart = null;

    function initCharts() {
      var gridColor = 'rgba(255,255,255,0.04)';
      var tickOpts = { color: '#64748b', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5 };

      memoryChart = new Chart(document.getElementById('memory-chart'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 300 },
          scales: {
            x: { ticks: tickOpts, grid: { color: gridColor } },
            y: { ticks: tickOpts, grid: { color: gridColor }, beginAtZero: true,
                 stacked: true, title: { display: true, text: 'GB', color: '#64748b' } },
          },
          plugins: {
            legend: { labels: { color: '#e2e8f0', font: { family: 'IBM Plex Sans', size: 11 }, boxWidth: 12 } },
          },
        },
      });

      cpuChart = new Chart(document.getElementById('cpu-chart'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 300 },
          scales: {
            x: { ticks: tickOpts, grid: { color: gridColor } },
            y: { ticks: tickOpts, grid: { color: gridColor }, beginAtZero: true,
                 title: { display: true, text: '%', color: '#64748b' } },
          },
          plugins: {
            legend: { labels: { color: '#e2e8f0', font: { family: 'IBM Plex Sans', size: 11 }, boxWidth: 12 } },
          },
        },
      });
    }

    function updateCharts(history) {
      if (!memoryChart) initCharts();
      if (!history || history.length === 0) return;

      var labels = history.map(function(h) {
        var d = new Date(h.timestamp);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      });

      // Collect all unique session labels across history
      var allLabels = {};
      history.forEach(function(h) {
        h.sessions.forEach(function(s) { allLabels[s.label] = true; });
      });
      var sessionLabels = Object.keys(allLabels);

      // Memory chart: stacked area per session
      memoryChart.data.labels = labels;
      memoryChart.data.datasets = sessionLabels.map(function(label, i) {
        return {
          label: label,
          data: history.map(function(h) {
            var s = h.sessions.find(function(s) { return s.label === label; });
            return s ? s.treeRssGB : 0;
          }),
          borderColor: SESSION_COLORS[i % SESSION_COLORS.length],
          backgroundColor: SESSION_COLORS[i % SESSION_COLORS.length] + '30',
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
        };
      });

      // Add total RAM ceiling line
      var totalRam = history[0] && history[0].system ? history[0].system.totalRamGB : null;
      if (totalRam) {
        memoryChart.data.datasets.push({
          label: 'Total RAM',
          data: history.map(function() { return totalRam; }),
          borderColor: '#ef4444', borderDash: [6, 4], borderWidth: 1,
          pointRadius: 0, fill: false, stack: 'ceiling',
        });
      }
      memoryChart.update('none');

      // CPU chart: one line per session
      cpuChart.data.labels = labels;
      cpuChart.data.datasets = sessionLabels.map(function(label, i) {
        return {
          label: label,
          data: history.map(function(h) {
            var s = h.sessions.find(function(s) { return s.label === label; });
            return s ? s.cpuPercent : 0;
          }),
          borderColor: SESSION_COLORS[i % SESSION_COLORS.length],
          backgroundColor: 'transparent',
          tension: 0.3, pointRadius: 0, borderWidth: 1.5,
        };
      });

      // Add 100% per-core dotted line
      cpuChart.data.datasets.push({
        label: '100% (1 core)',
        data: history.map(function() { return 100; }),
        borderColor: 'rgba(255,255,255,0.15)', borderDash: [4, 4],
        borderWidth: 1, pointRadius: 0, fill: false,
      });
      cpuChart.update('none');
    }
```

- [ ] **Step 2: Manual test**

```bash
npm start &
sleep 8
open http://localhost:4040
```

Verify: Memory area chart shows stacked areas with dashed red ceiling line. CPU line chart shows one line per session with dotted 100% reference. Charts update every 3 seconds. Wait ~15 seconds to see data accumulate.

```bash
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add Chart.js memory and CPU time-series charts"
```

---

## Task 8: index.html — Session Cards, Kill Button and Reconnection

**Files:**
- Modify: `public/index.html`

Replace the `renderSessionCards` stub with full card rendering including the kill button with confirmation UX.

- [ ] **Step 1: Replace the renderSessionCards stub**

In `public/index.html`, find and replace the existing `renderSessionCards` function (the stub from Task 6) with:

```js
    // ============================================================
    // SESSION CARDS
    // ============================================================
    var killTimers = {};

    function statusColor(treeRssGB) {
      if (treeRssGB > 4) return 'var(--red)';
      if (treeRssGB > 2) return 'var(--amber)';
      return 'var(--green)';
    }

    function barColor(pct) {
      if (pct > 85) return 'var(--red)';
      if (pct > 70) return 'var(--amber)';
      return 'var(--green)';
    }

    function formatTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'K';
      return String(n);
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function renderSessionCards(sessions) {
      var grid = document.getElementById('sessions-grid');
      var emptyState = document.getElementById('empty-state');

      if (sessions.length === 0) {
        grid.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';

      // Sort by memory usage (highest first)
      var sorted = sessions.slice().sort(function(a, b) { return b.treeRssGB - a.treeRssGB; });

      grid.innerHTML = sorted.map(function(s) {
        var memPct = Math.min(100, (s.treeRssGB / 8) * 100);
        var cpuPct = Math.min(100, s.cpuPercent);
        var isConfirming = !!killTimers[s.pid];

        return '<div class="session-card" id="card-' + s.pid + '">'
          + '<div class="session-header">'
          +   '<span class="session-label">'
          +     '<span class="status-dot" style="background:' + statusColor(s.treeRssGB) + '"></span>'
          +     escapeHtml(s.label)
          +   '</span>'
          +   '<span class="session-pid">PID ' + s.pid + '</span>'
          + '</div>'
          + '<div class="session-path">' + escapeHtml(s.workingDir) + '</div>'
          + '<div class="session-metrics">'
          +   '<div class="metric"><span class="metric-label">Memory</span><span class="metric-value">' + s.treeRssGB + ' GB</span></div>'
          +   '<div class="metric"><span class="metric-label">CPU</span><span class="metric-value">' + s.cpuPercent + '%</span></div>'
          +   '<div class="metric metric-bar"><div class="mini-bar"><div class="mini-fill" style="width:' + memPct + '%;background:' + barColor(memPct) + '"></div></div></div>'
          +   '<div class="metric"><span class="metric-label">Threads</span><span class="metric-value">' + s.threadCount + '</span></div>'
          +   '<div class="metric"><span class="metric-label">Children</span><span class="metric-value">' + s.childCount + '</span></div>'
          +   '<div class="metric"><span class="metric-label">Uptime</span><span class="metric-value">' + s.elapsed + '</span></div>'
          + '</div>'
          + '<div class="session-tokens">'
          +   'Tokens In: ' + formatTokens(s.tokens.input) + ' &nbsp; Out: ' + formatTokens(s.tokens.output)
          +   ' &nbsp; ~$' + s.tokens.estimatedCostUSD.toFixed(2) + '<br>'
          +   'Messages: ' + s.tokens.messageCount
          + '</div>'
          + '<button class="kill-btn' + (isConfirming ? ' confirming' : '') + '" onclick="handleKill(' + s.pid + ', this)">'
          +   (isConfirming ? 'Confirm Kill?' : 'Kill Session')
          + '</button>'
          + '<div style="clear:both"></div>'
          + '</div>';
      }).join('');
    }

    function handleKill(pid, btn) {
      if (!killTimers[pid]) {
        // First click: enter confirmation mode
        btn.textContent = 'Confirm Kill?';
        btn.classList.add('confirming');
        killTimers[pid] = setTimeout(function() {
          delete killTimers[pid];
          btn.textContent = 'Kill Session';
          btn.classList.remove('confirming');
        }, 3000);
        return;
      }

      // Second click: actually kill
      clearTimeout(killTimers[pid]);
      delete killTimers[pid];

      fetch('/api/kill/' + pid, { method: 'POST' })
        .then(function(res) {
          if (res.ok) {
            var card = document.getElementById('card-' + pid);
            if (card) card.classList.add('killing');
          } else {
            return res.json().then(function(data) { alert('Kill failed: ' + data.error); });
          }
        })
        .catch(function(err) {
          alert('Kill failed: ' + err.message);
        });
    }
```

- [ ] **Step 2: Full end-to-end manual test**

```bash
npm start &
sleep 2
open http://localhost:4040
```

Verify all of the following:
1. Header: pulsing green dot, "OVERWATCH" title, session count badge updates
2. System health strip: RAM with color-coded progress bar, Claude RAM total, CPU load, session count
3. Charts: Memory stacked area chart and CPU line chart updating every 3 seconds
4. Session cards: sorted by memory (highest first), colored status dots (green/amber/red), all metrics displayed, token info shown
5. Kill button: first click shows "Confirm Kill?" (red-dark), reverts after 3 seconds if not confirmed
6. If no Claude CLI sessions running: empty state message shown instead of cards
7. Stop the server and verify red "Connection lost" banner appears, green dot turns grey

```bash
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add session cards with kill confirmation and reconnection banner"
```

---

## Task 9: README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

Create `README.md`:

```markdown
# Overwatch

Local monitoring dashboard for Claude Code sessions on macOS. See which sessions are eating your RAM and kill them before your Mac locks up.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open [http://localhost:4040](http://localhost:4040)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `4040`  | Server port |

## Notes

- **macOS only** — uses `ps`, `vm_stat`, `sysctl`, and `lsof` for metrics collection
- **Full Disk Access** may be needed in System Settings > Privacy & Security for `lsof` to read working directories of some processes
- Token counts and cost estimates are approximate — based on conversation log file parsing
- No authentication — designed for local use only
```

- [ ] **Step 2: Final smoke test**

```bash
npm test && npm start &
sleep 3
curl -s http://localhost:4040/ | grep -c 'OVERWATCH'
kill %1
```

Expected: Tests pass, curl returns `1` (found OVERWATCH in HTML).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage instructions"
```

---

## Self-Review Results

**Spec coverage check:**
- Process discovery via `ps` with parent-child tree building
- System metrics via `vm_stat`, `sysctl`
- Working directory via `lsof`
- Thread count via `ps -M`
- Token estimation from `~/.claude/projects/` JSONL files
- 3-second polling, 20-minute rolling buffer (400 data points)
- WebSocket broadcast to all connected clients
- Kill endpoint with SIGTERM then SIGKILL after 2s escalation
- Dark mission-control theme with exact color palette (#0a0e17, #111827, etc.)
- JetBrains Mono + IBM Plex Sans from Google Fonts
- System health strip (4 cards: RAM with progress bar, Claude RAM, CPU, Sessions)
- Memory stacked area chart + CPU line chart with Chart.js from CDN
- Dashed total-RAM ceiling line on memory chart
- Dotted 100%-per-core reference line on CPU chart
- Session cards sorted by memory (highest first)
- Status dots: green (<2GB), amber (2-4GB), red (>4GB)
- Kill button with 3-second confirmation window
- Card fade-out on kill
- WebSocket reconnection banner + grey pulse dot on disconnect
- Empty state when no sessions detected
- Responsive: 2x2 health cards, stacked charts, auto-fill session grid
- Graceful degradation with try/catch on all system calls
- No sudo, no auth, no Docker, no TypeScript, no build step, no framework
- Port 4040 configurable via PORT env var
- Startup message with telescope emoji
- Footer with polling info
- README with setup notes

**Placeholder scan:** No TBD, TODO, or vague instructions found. All code steps contain actual implementation code.

**Type/name consistency check:**
- `parseVmStat`, `parseLoadAvg`, `parsePsOutput` — defined in Task 2, used internally in Task 2-3
- `buildProcessTree` — defined in Task 3, used in `getClaudeSessions` Task 3
- `getSystemMetrics`, `getClaudeSessions`, `collectAll` — defined in Tasks 2-3, imported in server.js Task 5
- `createServer` — defined in Task 4, used in tests Task 4/5
- WebSocket payload `{ current, history }` — set in server.js Task 5, consumed in index.html Task 6
- Session fields (`pid`, `label`, `workingDir`, `treeRssGB`, `rssGB`, `cpuPercent`, `threadCount`, `childCount`, `elapsed`, `tokens`) — produced by `getClaudeSessions` (Task 3), consumed by `renderSessionCards` (Task 8)
- `tokens.input`, `tokens.output`, `tokens.estimatedCostUSD`, `tokens.messageCount` — produced by `getTokenInfo` (Task 3), rendered in session cards (Task 8)
