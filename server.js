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
