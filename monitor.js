// Process discovery and metrics collection for macOS
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

function parseLoadAvg(output) {
  const match = output.match(/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/);
  if (!match) return { load1m: 0, load5m: 0, load15m: 0 };
  return {
    load1m: parseFloat(match[1]),
    load5m: parseFloat(match[2]),
    load15m: parseFloat(match[3]),
  };
}

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
    claudeRamGB: 0,
    cpuLoadAvg1m: load.load1m,
    cpuCores,
    cpuLoadPercent,
  };
}

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

function getThreadCount(pid) {
  try {
    const output = execSync(`ps -M ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const lines = output.trim().split('\n');
    return Math.max(lines.length - 1, 1);
  } catch {
    return 1;
  }
}

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

function getClaudeSessions() {
  let psOutput;
  try {
    psOutput = execSync('ps -eo pid,ppid,rss,%cpu,etime,command', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }

  const allProcesses = parsePsOutput(psOutput);

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

// System processes to exclude from resource hog detection
const SYSTEM_PROCESS_NAMES = new Set([
  'kernel_task', 'launchd', 'WindowServer', 'loginwindow', 'Finder',
  'Dock', 'SystemUIServer', 'mds', 'mds_stores', 'mdworker',
  'spotlight', 'coreaudiod', 'bluetoothd', 'airportd', 'sharingd',
  'cloudd', 'bird', 'nsurlsessiond', 'trustd', 'syslogd',
  'distnoted', 'cfprefsd', 'lsd', 'containermanagerd',
  'com.apple.WebKit', 'Safari', 'Mail', 'Messages', 'Music',
  'Photos', 'Calendar', 'Notes', 'Reminders', 'FaceTime',
  'Activity Monitor', 'sysmond', 'symptomsd', 'powerd',
]);

const RSS_THRESHOLD_KB = 200 * 1024; // 200 MB

function getResourceHogs(claudePids) {
  let psOutput;
  try {
    psOutput = execSync('ps -eo pid,ppid,rss,%cpu,etime,command', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }

  const allProcesses = parsePsOutput(psOutput);
  const claudePidSet = new Set(claudePids);
  const myPid = process.pid;

  // Filter to high-RAM processes that aren't Claude sessions, system procs, or us
  const hogs = allProcesses.filter(p => {
    if (p.rssKB < RSS_THRESHOLD_KB) return false;
    if (claudePidSet.has(p.pid)) return false;
    if (p.pid === myPid) return false;
    const baseName = path.basename(p.command.split(/\s/)[0]);
    if (SYSTEM_PROCESS_NAMES.has(baseName)) return false;
    return true;
  });

  return hogs.map(proc => {
    const workingDir = getWorkingDir(proc.pid);
    const baseName = path.basename(proc.command.split(/\s/)[0]);
    const label = workingDir && workingDir !== '/'
      ? path.basename(workingDir)
      : baseName || `pid-${proc.pid}`;

    return {
      pid: proc.pid,
      workingDir: workingDir || 'unknown',
      label,
      command: proc.command,
      rssGB: Math.round((proc.rssKB / 1048576) * 100) / 100,
      rssMB: Math.round(proc.rssKB / 1024),
      cpuPercent: proc.cpuPercent,
      elapsed: proc.elapsed,
    };
  });
}

function collectAll() {
  const system = getSystemMetrics();
  const sessions = getClaudeSessions();
  system.claudeRamGB = Math.round(sessions.reduce((sum, s) => sum + s.treeRssGB, 0) * 100) / 100;
  const claudePids = sessions.map(s => s.pid);
  const resourceHogs = getResourceHogs(claudePids);
  return {
    timestamp: new Date().toISOString(),
    system,
    sessions,
    resourceHogs,
  };
}

module.exports = {
  parseVmStat,
  parseLoadAvg,
  parsePsOutput,
  buildProcessTree,
  getSystemMetrics,
  getClaudeSessions,
  getResourceHogs,
  collectAll,
};
