const express = require('express');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { collectAll } = require('./monitor');
const { detectAlerts: _detectAlerts, detectRunaway: _detectRunaway, detectBurst: _detectBurst } = require('./alerts');

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
    for (const session of current.sessions) {
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
