const express = require('express');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { collectAll } = require('./monitor');
const { detectAlerts: _detectAlerts } = require('./alerts');

const DEFAULT_PORT = 4040;
const POLL_INTERVAL_MS = 3000;
const FAST_POLL_INTERVAL_MS = 500;
const MAX_HISTORY_POINTS = Math.floor((20 * 60 * 1000) / POLL_INTERVAL_MS); // 400 points = 20 minutes

// RAM protection thresholds (configurable via env)
const RAM_CEILING_PCT = parseInt(process.env.OW_RAM_CEILING_PCT) || 80;        // auto-kill session above this % of total RAM
const RAM_SPIKE_GB_PER_SEC = parseFloat(process.env.OW_RAM_SPIKE_GB_S) || 0.5; // rate-of-change alert threshold
const RAM_PRESSURE_FREE_GB = parseFloat(process.env.OW_RAM_PRESSURE_GB) || 2;  // switch to fast polling below this

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
      || alerts.some(a => a.type === 'ram_spike');
    const targetMs = underPressure ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

    if (targetMs !== currentPollMs) {
      console.log(`[OVERWATCH] Polling ${currentPollMs}ms → ${targetMs}ms (pressure=${underPressure})`);
      currentPollMs = targetMs;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, currentPollMs);
    }
  }

  function broadcast(data) {
    const payload = JSON.stringify({ current: data, history, alerts });
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
      autoKillOverCeiling(data);

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
    ws.send(JSON.stringify({ current, history, alerts }));
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
