// Dev project registry — port allocation, process scanning, cache management
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY_PATH = path.join(os.homedir(), '.dev-registry.json');
const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3299;

const DEFAULT_REGISTRY = {
  projects: {
    'ivi-website': {
      port: 3000,
      path: '~/projects/Lumirah/ivi-website',
      command: 'npm run dev',
      group: 'lumirah',
      description: 'iVi product website (Next.js)',
      memoryLimitMB: 2048,
    },
    'hopcircle': {
      port: 3001,
      path: '~/projects/hopcircle-site',
      command: 'npm run dev',
      group: 'apps',
      description: 'HopCircle website (Next.js)',
      memoryLimitMB: 1024,
    },
    'empax-layer': {
      port: 3002,
      path: '~/projects/empax-layer',
      command: 'npm run dev',
      group: 'emyria',
      description: 'Empax Layer service',
      memoryLimitMB: 2048,
    },
    'bridgetime': {
      port: 3003,
      path: '~/projects/bridgetime',
      command: 'npm run dev',
      group: 'apps',
      description: 'BridgeTime app',
      memoryLimitMB: 1024,
    },
    'overwatch': {
      port: 3100,
      path: '~/Documents/Overwatch',
      command: 'npm start',
      group: 'infra',
      description: 'Dev orchestration hub',
      memoryLimitMB: 512,
    },
    'winston': {
      port: 3150,
      path: '~/Documents/Winston',
      command: 'npm start',
      group: 'infra',
      description: 'Winston monitoring service',
      memoryLimitMB: 512,
    },
  },
  portRanges: {
    'web-apps': '3000-3099 — Next.js / React dev servers',
    'infra': '3100-3199 — Overwatch, Winston, internal tools',
    'api': '3200-3299 — backend APIs, FastAPI, Express',
  },
};

function expandPath(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function collapsePath(p) {
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (!data.projects) data.projects = {};
    if (!data.portRanges) data.portRanges = DEFAULT_REGISTRY.portRanges;
    return data;
  } catch {
    return null;
  }
}

function writeRegistry(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    writeRegistry(DEFAULT_REGISTRY);
    return DEFAULT_REGISTRY;
  }
  return readRegistry();
}

// TCP port check — resolves true if something is listening
function checkPort(port, timeout = 300) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

// Get PID listening on a port
function getPidOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    return parseInt(out.split('\n')[0]);
  } catch {
    return null;
  }
}

// Get process stats by PID
function getProcessStats(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'rss=,pcpu=,etime=,command='], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    const parts = out.trim().split(/\s+/);
    if (parts.length < 3) return null;
    return {
      pid,
      rssKB: parseInt(parts[0]),
      rssMB: Math.round(parseInt(parts[0]) / 1024),
      cpuPercent: parseFloat(parts[1]),
      elapsed: parts[2],
      command: parts.slice(3).join(' '),
    };
  } catch {
    return null;
  }
}

// Get full process tree RSS for a PID (parent + all children)
function getTreeRssMB(pid) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,ppid,rss'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = out.trim().split('\n').slice(1);
    const procs = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        procs.push({ pid: parseInt(parts[0]), ppid: parseInt(parts[1]), rss: parseInt(parts[2]) });
      }
    }

    const childrenOf = new Map();
    for (const p of procs) {
      if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
      childrenOf.get(p.ppid).push(p);
    }

    let totalKB = 0;
    const root = procs.find(p => p.pid === pid);
    if (root) totalKB += root.rss;

    function addChildren(parentPid) {
      for (const child of (childrenOf.get(parentPid) || [])) {
        totalKB += child.rss;
        addChildren(child.pid);
      }
    }
    addChildren(pid);

    return Math.round(totalKB / 1024);
  } catch {
    return 0;
  }
}

// Scan all registered projects for status
async function getProjectStatuses(registry) {
  const projects = registry.projects;
  const results = {};

  const entries = Object.entries(projects);
  const portChecks = await Promise.all(
    entries.map(([, proj]) => checkPort(proj.port))
  );

  for (let i = 0; i < entries.length; i++) {
    const [name, proj] = entries[i];
    const alive = portChecks[i];
    const info = {
      name,
      port: proj.port,
      path: proj.path,
      expandedPath: expandPath(proj.path),
      command: proj.command,
      group: proj.group,
      description: proj.description,
      memoryLimitMB: proj.memoryLimitMB,
      running: alive,
      pid: null,
      rssMB: 0,
      treeRssMB: 0,
      cpuPercent: 0,
      elapsed: null,
      memoryPct: 0,
    };

    if (alive) {
      const pid = getPidOnPort(proj.port);
      if (pid) {
        info.pid = pid;
        const stats = getProcessStats(pid);
        if (stats) {
          info.rssMB = stats.rssMB;
          info.cpuPercent = stats.cpuPercent;
          info.elapsed = stats.elapsed;
        }
        info.treeRssMB = getTreeRssMB(pid);
        if (proj.memoryLimitMB > 0) {
          info.memoryPct = Math.round((info.treeRssMB / proj.memoryLimitMB) * 100);
        }
      }
    }

    results[name] = info;
  }

  return results;
}

// Scan for rogue processes on ports in our range but not registered
async function findRogueProcesses(registry) {
  const registeredPorts = new Set(
    Object.values(registry.projects).map(p => p.port)
  );

  const rogues = [];
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!registeredPorts.has(p)) ports.push(p);
  }

  // Check in batches of 50 to avoid fd exhaustion
  const BATCH = 50;
  for (let i = 0; i < ports.length; i += BATCH) {
    const batch = ports.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(p => checkPort(p)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        const pid = getPidOnPort(batch[j]);
        const stats = pid ? getProcessStats(pid) : null;
        rogues.push({
          port: batch[j],
          pid,
          rssMB: stats ? stats.rssMB : 0,
          cpuPercent: stats ? stats.cpuPercent : 0,
          command: stats ? stats.command : 'unknown',
          elapsed: stats ? stats.elapsed : null,
        });
      }
    }
  }

  return rogues;
}

// Cache scanning
const CACHE_DIRS = ['.next', 'node_modules/.cache', '.turbo', 'dist', '.output'];

function getDirSizeMB(dirPath) {
  try {
    const out = execFileSync('du', ['-sk', dirPath], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const kb = parseInt(out.split(/\s/)[0]);
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

function scanCaches(registry) {
  const results = {};
  for (const [name, proj] of Object.entries(registry.projects)) {
    const base = expandPath(proj.path);
    const caches = [];
    let totalMB = 0;

    for (const dir of CACHE_DIRS) {
      const full = path.join(base, dir);
      if (fs.existsSync(full)) {
        const sizeMB = getDirSizeMB(full);
        caches.push({ dir, sizeMB });
        totalMB += sizeMB;
      }
    }

    results[name] = { path: proj.path, caches, totalMB };
  }
  return results;
}

function cleanProjectCaches(registry, projectName) {
  const proj = registry.projects[projectName];
  if (!proj) return { error: 'Project not found' };

  const base = expandPath(proj.path);
  const cleaned = [];
  let totalFreedMB = 0;

  for (const dir of CACHE_DIRS) {
    const full = path.join(base, dir);
    if (fs.existsSync(full)) {
      const sizeMB = getDirSizeMB(full);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        cleaned.push({ dir, freedMB: sizeMB });
        totalFreedMB += sizeMB;
      } catch (err) {
        cleaned.push({ dir, error: err.message });
      }
    }
  }

  return { project: projectName, cleaned, totalFreedMB };
}

// Sync PORT= into project .env files
function syncEnvPort(registry, projectName) {
  const proj = registry.projects[projectName];
  if (!proj) return { error: 'Project not found' };

  const projPath = expandPath(proj.path);
  if (!fs.existsSync(projPath)) {
    return { project: projectName, synced: false, reason: 'path does not exist' };
  }

  const envPath = path.join(projPath, '.env');
  const portLine = `PORT=${proj.port}`;
  let content = '';

  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    // No .env yet — create it
  }

  const lines = content.split('\n');
  let found = false;
  const updated = lines.map(line => {
    if (/^PORT\s*=/.test(line)) {
      found = true;
      return portLine;
    }
    return line;
  });

  if (!found) {
    updated.unshift(portLine);
  }

  fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
  return { project: projectName, synced: true, port: proj.port };
}

function syncAllEnvs(registry) {
  const results = [];
  for (const name of Object.keys(registry.projects)) {
    results.push(syncEnvPort(registry, name));
  }
  return results;
}

function validateRegistration(registry, name, data) {
  if (!data.port || !data.path) {
    return 'port and path are required';
  }
  const port = parseInt(data.port);
  if (isNaN(port) || port < 1024 || port > 65535) {
    return 'port must be 1024-65535';
  }
  for (const [existingName, proj] of Object.entries(registry.projects)) {
    if (existingName !== name && proj.port === port) {
      return `port ${port} already assigned to ${existingName}`;
    }
  }
  return null;
}

module.exports = {
  REGISTRY_PATH,
  PORT_RANGE_START,
  PORT_RANGE_END,
  expandPath,
  collapsePath,
  readRegistry,
  writeRegistry,
  ensureRegistry,
  checkPort,
  getPidOnPort,
  getProcessStats,
  getTreeRssMB,
  getProjectStatuses,
  findRogueProcesses,
  scanCaches,
  cleanProjectCaches,
  syncEnvPort,
  syncAllEnvs,
  validateRegistration,
};
