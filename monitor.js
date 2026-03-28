// Process discovery and metrics collection for macOS
const { execSync } = require('child_process');

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

module.exports = { parseVmStat, parseLoadAvg, parsePsOutput, getSystemMetrics };
