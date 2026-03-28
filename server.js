const express = require('express');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_PORT = 4040;

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
