// Dev project registry — port allocation, process scanning, cache management
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY_PATH = path.join(os.homedir(), '.dev-registry.json');

const DEFAULT_REGISTRY = {
  projects: {
    'my-app': {
      port: 3000,
      path: '~/projects/my-app',
      command: 'npm run dev',
      group: 'apps',
      description: 'Example app (Next.js)',
      memoryLimitMB: 1024,
    },
  },
  portRanges: {
    'web-apps': '3000-3099 — Next.js / React dev servers',
    'infra': '3100-3199 — internal tools',
    'api': '3200-3299 — backend APIs',
  },
};

// In-memory tracking of when each project was last observed running.
// Lost on server restart — sufficient for current needs.
const lastSeenAt = new Map();
function touchLastSeen(name) { lastSeenAt.set(name, Date.now()); }
function getLastSeen(name) { return lastSeenAt.has(name) ? lastSeenAt.get(name) : null; }
function _resetLastSeen() { lastSeenAt.clear(); }

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
function getTreeRssMB(pid, excludePids) {
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

    // Skip excluded PIDs and their entire subtrees (e.g. detached spawned processes
    // that haven't been reparented yet)
    const skip = excludePids ? new Set(excludePids) : new Set();

    let totalKB = 0;
    const root = procs.find(p => p.pid === pid);
    if (root) totalKB += root.rss;

    function addChildren(parentPid) {
      for (const child of (childrenOf.get(parentPid) || [])) {
        if (skip.has(child.pid)) continue;
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
// excludePids: optional array of PIDs to exclude from tree RSS walks (e.g. detached spawned children)
async function getProjectStatuses(registry, excludePids) {
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
        info.treeRssMB = getTreeRssMB(pid, excludePids);
        if (proj.memoryLimitMB > 0) {
          info.memoryPct = Math.round((info.treeRssMB / proj.memoryLimitMB) * 100);
        }
      }
    }

    if (info.running) touchLastSeen(name);
    info.lastSeenMs = getLastSeen(name);

    results[name] = info;
  }

  return results;
}

// Discover ALL TCP listening ports on the system via a single lsof call
function getAllListeningPorts() {
  try {
    const out = execFileSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-Pn'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = out.trim().split('\n').slice(1); // skip header
    const seen = new Map(); // port → { port, pid, command }
    for (const line of lines) {
      const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1]);
      if (seen.has(port)) continue;
      const parts = line.trim().split(/\s+/);
      const command = parts[0];
      const pid = parseInt(parts[1]);
      if (!isNaN(pid)) seen.set(port, { port, pid, command });
    }
    return Array.from(seen.values());
  } catch {
    return [];
  }
}

// Scan for rogue processes — any listening port not in the registry
function findRogueProcesses(registry) {
  const registeredPorts = new Set();
  for (const proj of Object.values(registry.projects)) {
    registeredPorts.add(proj.port);
    if (proj.services) {
      for (const port of Object.values(proj.services)) {
        registeredPorts.add(port);
      }
    }
  }

  const allPorts = getAllListeningPorts();
  const rogues = [];

  for (const entry of allPorts) {
    if (registeredPorts.has(entry.port)) continue;
    const stats = entry.pid ? getProcessStats(entry.pid) : null;
    rogues.push({
      port: entry.port,
      pid: entry.pid,
      rssMB: stats ? stats.rssMB : 0,
      cpuPercent: stats ? stats.cpuPercent : 0,
      command: stats ? stats.command : entry.command || 'unknown',
      elapsed: stats ? stats.elapsed : null,
    });
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
function syncEnvFile(filePath, port) {
  const portLine = `PORT=${port}`;
  let content = '';

  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // File doesn't exist — skip rather than create
    return false;
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

  fs.writeFileSync(filePath, updated.join('\n'), 'utf8');
  return true;
}

function syncEnvPort(registry, projectName) {
  const proj = registry.projects[projectName];
  if (!proj) return { error: 'Project not found' };

  const projPath = expandPath(proj.path);
  if (!fs.existsSync(projPath)) {
    return { project: projectName, synced: false, reason: 'path does not exist' };
  }

  // Sync PORT into both .env and .env.local (Next.js reads .env.local first)
  const synced = [];
  for (const filename of ['.env', '.env.local']) {
    const filePath = path.join(projPath, filename);
    if (syncEnvFile(filePath, proj.port)) {
      synced.push(filename);
    }
  }

  return { project: projectName, synced: synced.length > 0, files: synced, port: proj.port };
}

function syncAllEnvs(registry) {
  const results = [];
  for (const name of Object.keys(registry.projects)) {
    results.push(syncEnvPort(registry, name));
  }
  return results;
}

// Get all ports claimed by the registry (primary + services)
function getAllClaimedPorts(registry) {
  const claimed = new Map(); // port → "projectName" or "projectName/serviceName"
  for (const [name, proj] of Object.entries(registry.projects)) {
    claimed.set(proj.port, name);
    if (proj.services) {
      for (const [svc, port] of Object.entries(proj.services)) {
        claimed.set(port, name + '/' + svc);
      }
    }
  }
  return claimed;
}

function validateRegistration(registry, name, data) {
  if (!data.port || !data.path) {
    return 'port and path are required';
  }
  const port = parseInt(data.port);
  if (isNaN(port) || port < 1024 || port > 65535) {
    return 'port must be 1024-65535';
  }
  const claimed = getAllClaimedPorts(registry);
  const owner = claimed.get(port);
  if (owner && owner !== name && !owner.startsWith(name + '/')) {
    return `port ${port} already assigned to ${owner}`;
  }
  return null;
}

module.exports = {
  REGISTRY_PATH,
  expandPath,
  collapsePath,
  readRegistry,
  writeRegistry,
  ensureRegistry,
  checkPort,
  getAllClaimedPorts,
  getPidOnPort,
  getProcessStats,
  getTreeRssMB,
  getProjectStatuses,
  getAllListeningPorts,
  findRogueProcesses,
  scanCaches,
  cleanProjectCaches,
  syncEnvPort,
  syncAllEnvs,
  validateRegistration,
  touchLastSeen,
  getLastSeen,
  _resetLastSeen,
};
