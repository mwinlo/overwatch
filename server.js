const express = require('express');
const http = require('http');
const path = require('path');
const { execSync, spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const treeKill = require('tree-kill');
const { collectAll } = require('./monitor');
const { detectAlerts: _detectAlerts, detectRunaway: _detectRunaway, detectBurst: _detectBurst } = require('./alerts');
const registry = require('./registry');

const DEFAULT_PORT = 4040;
const POLL_INTERVAL_MS = 3000;
const FAST_POLL_INTERVAL_MS = 500;
const MAX_HISTORY_POINTS = Math.floor((20 * 60 * 1000) / POLL_INTERVAL_MS); // 400 points = 20 minutes

// RAM protection thresholds (configurable via env)
const RAM_CEILING_PCT = parseInt(process.env.OW_RAM_CEILING_PCT) || 80;        // auto-kill session above this % of total RAM
const RAM_SPIKE_GB_PER_SEC = parseFloat(process.env.OW_RAM_SPIKE_GB_S) || 0.5; // rate-of-change alert threshold
const RAM_PRESSURE_FREE_GB = parseFloat(process.env.OW_RAM_PRESSURE_GB) || 2;  // switch to fast polling below this
const RUNAWAY_HORIZON_SEC = parseInt(process.env.OW_RUNAWAY_HORIZON_SEC) || 120; // alert if ceiling projected within this many seconds
const BURST_GB_PER_SEC = parseFloat(process.env.OW_BURST_GB_S) || 0.2;          // burst avg rate threshold over short window
const GROWTH_WINDOW_SIZE = 10;                                                   // rolling window of samples per session (~30s)

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

  // Kill any user-owned process by PID (for resource hogs)
  app.post('/api/kill-process/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid) || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });

    // Safety: don't kill ourselves
    if (pid === process.pid) return res.status(403).json({ error: 'Cannot kill Overwatch' });

    treeKill(pid, 'SIGTERM', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      setTimeout(() => {
        try { process.kill(pid, 0); treeKill(pid, 'SIGKILL'); } catch {}
      }, 2000);
      res.json({ success: true, pid });
    });
  });

  // ---- Start button: track spawned PIDs ----
  const spawnedPids = new Map(); // name → pid

  // ---- Dev Registry API ----
  // Ensure registry exists on startup
  registry.ensureRegistry();

  app.use(express.json());

  // Project statuses + rogue process scan
  app.get('/api/status', async (req, res) => {
    try {
      const reg = registry.ensureRegistry();
      // Clean up dead spawned PIDs so the exclude list doesn't grow forever
      for (const [name, pid] of spawnedPids) {
        try { process.kill(pid, 0); } catch { spawnedPids.delete(name); }
      }
      const excludePids = Array.from(spawnedPids.values());
      const [projects, rogues] = await Promise.all([
        registry.getProjectStatuses(reg, excludePids),
        registry.findRogueProcesses(reg),
      ]);

      // Summary stats
      const projectList = Object.values(projects);
      const running = projectList.filter(p => p.running);
      const totalMemMB = running.reduce((sum, p) => sum + p.treeRssMB, 0);
      const totalPorts = running.length;

      res.json({
        projects,
        rogues,
        summary: { totalMemMB, totalPorts, totalProjects: projectList.length, rogueCount: rogues.length },
        portRanges: reg.portRanges,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Register / update a project
  app.post('/api/register', (req, res) => {
    const { name, port, path: projPath, command, group, description, memoryLimitMB } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const reg = registry.ensureRegistry();
    const validationError = registry.validateRegistration(reg, name, { port, path: projPath });
    if (validationError) return res.status(400).json({ error: validationError });

    reg.projects[name] = {
      port: parseInt(port),
      path: projPath || '',
      command: command || 'npm run dev',
      group: group || 'apps',
      description: description || '',
      memoryLimitMB: parseInt(memoryLimitMB) || 1024,
    };
    registry.writeRegistry(reg);
    // Auto-sync PORT into the project's env files
    registry.syncEnvPort(reg, name);
    res.json({ success: true, project: reg.projects[name] });
  });

  // Remove a project
  app.delete('/api/register/:name', (req, res) => {
    const reg = registry.ensureRegistry();
    if (!reg.projects[req.params.name]) {
      return res.status(404).json({ error: 'Project not found' });
    }
    delete reg.projects[req.params.name];
    registry.writeRegistry(reg);
    res.json({ success: true });
  });

  // Kill a project's process tree by name
  app.post('/api/kill-project/:name', async (req, res) => {
    const reg = registry.ensureRegistry();
    const proj = reg.projects[req.params.name];
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const pid = registry.getPidOnPort(proj.port);
    if (!pid) return res.status(404).json({ error: 'Process not running' });

    treeKill(pid, 'SIGTERM', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      // Follow up with SIGKILL after 2s if still alive
      setTimeout(() => {
        try { process.kill(pid, 0); treeKill(pid, 'SIGKILL'); } catch {}
      }, 2000);
      res.json({ success: true, pid, project: req.params.name });
    });
  });

  // Kill a rogue process by port
  app.post('/api/kill-port/:port', (req, res) => {
    const port = parseInt(req.params.port);
    if (isNaN(port)) return res.status(400).json({ error: 'Invalid port' });

    const pid = registry.getPidOnPort(port);
    if (!pid) return res.status(404).json({ error: 'No process on port' });

    treeKill(pid, 'SIGTERM', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      setTimeout(() => {
        try { process.kill(pid, 0); treeKill(pid, 'SIGKILL'); } catch {}
      }, 2000);
      res.json({ success: true, pid, port });
    });
  });

  // Kill all visible rogues by port list
  app.post('/api/kill-all-rogues', (req, res) => {
    const ports = req.body && Array.isArray(req.body.ports) ? req.body.ports : null;
    if (!ports || ports.length === 0) {
      return res.status(400).json({ error: 'ports (non-empty array) is required' });
    }
    const results = ports.map(p => {
      const port = parseInt(p);
      if (isNaN(port)) return { port: p, ok: false, error: 'invalid port' };
      const pid = registry.getPidOnPort(port);
      if (!pid) return { port, ok: false, error: 'no process' };
      try {
        treeKill(pid, 'SIGTERM');
        setTimeout(() => {
          try { process.kill(pid, 0); treeKill(pid, 'SIGKILL'); } catch {}
        }, 2000);
        return { port, ok: true, pid };
      } catch (err) {
        return { port, ok: false, error: err.message };
      }
    });
    res.json({ results });
  });

  // Scan build caches
  app.get('/api/caches', (req, res) => {
    const reg = registry.ensureRegistry();
    const caches = registry.scanCaches(reg);
    const totalMB = Object.values(caches).reduce((sum, c) => sum + c.totalMB, 0);
    res.json({ caches, totalMB });
  });

  // Clean caches for a project
  app.post('/api/clean/:name', (req, res) => {
    const reg = registry.ensureRegistry();
    const result = registry.cleanProjectCaches(reg, req.params.name);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  });

  // Sync PORT= into all .env files
  app.post('/api/sync-all-envs', (req, res) => {
    const reg = registry.ensureRegistry();
    const results = registry.syncAllEnvs(reg);
    res.json({ results });
  });

  // Start a project's dev server and open browser when port responds
  app.post('/api/start/:name', async (req, res) => {
    const reg = registry.ensureRegistry();
    const proj = reg.projects[req.params.name];
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const portInUse = await registry.checkPort(proj.port);
    if (portInUse) return res.status(409).json({ error: 'Port ' + proj.port + ' is already in use' });

    // Sync PORT into env files before spawning
    registry.syncEnvPort(reg, req.params.name);

    // Ensure log directory exists
    const logDir = path.join(os.homedir(), '.overwatch', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, req.params.name + '.log');
    const logStream = fs.openSync(logFile, 'w');

    const expandedPath = registry.expandPath(proj.path);
    const child = spawn(proj.command, {
      cwd: expandedPath,
      shell: true,
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env: { ...process.env, PORT: String(proj.port) },
    });
    child.unref();
    fs.closeSync(logStream);

    spawnedPids.set(req.params.name, child.pid);

    // Poll for port to come alive
    const pollInterval = 500;
    const maxWait = 30000;
    let elapsed = 0;
    let opened = false;

    while (elapsed < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;
      if (await registry.checkPort(proj.port)) {
        execFile('open', ['http://localhost:' + proj.port], () => {});
        opened = true;
        break;
      }
    }

    res.json({
      success: true,
      pid: child.pid,
      port: proj.port,
      opened,
      ...(opened ? {} : { message: 'started but port not responding yet' }),
    });
  });

  // Rolling history buffer
  const history = [];
  let previousSnapshot = null;
  let alerts = [];              // current active alerts
  let killedPids = new Set();   // PIDs we've already auto-killed this cycle
  let currentPollMs = POLL_INTERVAL_MS;
  let pollTimer = null;
  let exitedSessions = [];        // recently exited sessions with timestamps
  const EXITED_TTL_MS = 30000;    // show tombstones for 30 seconds
  const growthTracker = new Map(); // PID → [{timestamp, treeRssGB}, ...] rolling window

  function detectAlerts(current, prev) {
    return _detectAlerts(current, prev, {
      spikeGBPerSec: RAM_SPIKE_GB_PER_SEC,
      ceilingPct: RAM_CEILING_PCT,
      pressureFreeGB: RAM_PRESSURE_FREE_GB,
    });
  }

  function autoKillOverCeiling(current) {
    const ceilingGB = current.system.totalRamGB * (RAM_CEILING_PCT / 100);
    const myPid = process.pid;
    for (const session of current.sessions) {
      // Never auto-kill ourselves — our tree RSS can be inflated by spawned dev servers
      if (session.pid === myPid) continue;
      if (session.treeRssGB >= ceilingGB && !killedPids.has(session.pid)) {
        console.warn(`[OVERWATCH AUTO-KILL] PID ${session.pid} (${session.label}) at ${session.treeRssGB} GB — exceeds ${RAM_CEILING_PCT}% ceiling`);
        killedPids.add(session.pid);
        try {
          process.kill(session.pid, 'SIGTERM');
          setTimeout(() => {
            try { process.kill(session.pid, 0); process.kill(session.pid, 'SIGKILL'); } catch {}
          }, 2000);
        } catch (err) {
          console.error(`[OVERWATCH] Failed to kill PID ${session.pid}:`, err.message);
        }
      }
    }
    // Clean killed PIDs for sessions that no longer exist
    const activePids = new Set(current.sessions.map(s => s.pid));
    for (const pid of killedPids) {
      if (!activePids.has(pid)) killedPids.delete(pid);
    }
  }

  function adjustPollingSpeed(current) {
    const underPressure = current.system.availableRamGB < RAM_PRESSURE_FREE_GB
      || alerts.some(a => a.type === 'ram_spike' || a.type === 'ram_burst' || a.type === 'ram_runaway');
    const targetMs = underPressure ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

    if (targetMs !== currentPollMs) {
      console.log(`[OVERWATCH] Polling ${currentPollMs}ms → ${targetMs}ms (pressure=${underPressure})`);
      currentPollMs = targetMs;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, currentPollMs);
    }
  }

  function broadcast(data) {
    const payload = JSON.stringify({ current: data, history, alerts, exitedSessions });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function poll() {
    try {
      const data = collectAll();
      alerts = detectAlerts(data, previousSnapshot);

      // Update per-session growth tracker
      const activePidSet = new Set();
      for (const session of data.sessions) {
        activePidSet.add(session.pid);
        let samples = growthTracker.get(session.pid);
        if (!samples) {
          samples = [];
          growthTracker.set(session.pid, samples);
        }
        samples.push({ timestamp: data.timestamp, treeRssGB: session.treeRssGB });
        if (samples.length > GROWTH_WINDOW_SIZE) samples.shift();
      }
      // Clean up tracker for sessions that no longer exist
      for (const pid of growthTracker.keys()) {
        if (!activePidSet.has(pid)) growthTracker.delete(pid);
      }

      // Detect burst and runaway sessions, merge alerts
      const burstAlerts = _detectBurst(data, growthTracker, {
        burstGBPerSec: BURST_GB_PER_SEC,
      });
      const runawayAlerts = _detectRunaway(data, growthTracker, {
        ceilingPct: RAM_CEILING_PCT,
        runawayHorizonSec: RUNAWAY_HORIZON_SEC,
      });
      alerts.push(...burstAlerts, ...runawayAlerts);

      autoKillOverCeiling(data);

      // Track exited sessions from alerts
      const now = Date.now();
      for (const alert of alerts) {
        if (alert.type === 'session_exited') {
          // Avoid duplicates (same PID already in tombstone list)
          if (!exitedSessions.some(e => e.pid === alert.pid)) {
            exitedSessions.push({ ...alert.exitedSession, exitedAt: now });
            console.log(`[OVERWATCH] Session exited: ${alert.label} (PID ${alert.pid})`);
          }
        }
      }
      // Expire old tombstones
      exitedSessions = exitedSessions.filter(e => now - e.exitedAt < EXITED_TTL_MS);

      history.push(data);
      if (history.length > MAX_HISTORY_POINTS) history.shift();

      broadcast(data);
      adjustPollingSpeed(data);
      previousSnapshot = data;
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }

  // Collect initial snapshot
  try {
    const initial = collectAll();
    history.push(initial);
    previousSnapshot = initial;
  } catch (err) {
    console.error('Initial collection failed:', err.message);
  }

  // Start polling
  pollTimer = setInterval(poll, currentPollMs);

  // On new connection, send current state immediately
  wss.on('connection', ws => {
    const current = history.length > 0 ? history[history.length - 1] : collectAll();
    ws.send(JSON.stringify({ current, history, alerts, exitedSessions }));
  });

  // Clean shutdown
  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(pollTimer);
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
