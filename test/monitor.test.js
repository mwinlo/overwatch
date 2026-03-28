const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseVmStat, parseLoadAvg, parsePsOutput, getSystemMetrics, buildProcessTree, getClaudeSessions, collectAll } = require('../monitor');

const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                2678.
Pages active:                            281858.
Pages inactive:                          280408.
Pages speculative:                          280.
Pages throttled:                              0.
Pages wired down:                        133475.
Pages purgeable:                              0.
"Translation faults":                  34472525.
Pages copy-on-write:                     307813.`;

const PS_FIXTURE = `  PID  PPID      RSS  %CPU     ELAPSED COMMAND
 1745   735   328256  12.5    06:12:00 claude
 1356   740   299776   8.7    07:47:00 claude
 2001  1745    12288   0.5    00:30:00 /bin/bash
 2002  2001     4096   0.1    00:15:00 grep something`;

describe('parseVmStat', () => {
  it('extracts page size from header', () => {
    const result = parseVmStat(VM_STAT_FIXTURE);
    assert.equal(result.pageSize, 16384);
  });

  it('extracts page counts', () => {
    const result = parseVmStat(VM_STAT_FIXTURE);
    assert.equal(result.free, 2678);
    assert.equal(result.active, 281858);
    assert.equal(result.inactive, 280408);
    assert.equal(result.wired, 133475);
  });

  it('defaults page size to 16384 if header is malformed', () => {
    const malformed = VM_STAT_FIXTURE.replace('page size of 16384 bytes', 'malformed header');
    const result = parseVmStat(malformed);
    assert.equal(result.pageSize, 16384);
  });
});

describe('parseLoadAvg', () => {
  it('extracts three load averages correctly', () => {
    const result = parseLoadAvg('{ 2.90 6.62 5.54 }');
    assert.equal(result.load1m, 2.90);
    assert.equal(result.load5m, 6.62);
    assert.equal(result.load15m, 5.54);
  });

  it('returns zeros for unparseable input', () => {
    const result = parseLoadAvg('garbage input');
    assert.equal(result.load1m, 0);
    assert.equal(result.load5m, 0);
    assert.equal(result.load15m, 0);
  });
});

describe('parsePsOutput', () => {
  it('parses all rows skipping header', () => {
    const result = parsePsOutput(PS_FIXTURE);
    assert.equal(result.length, 4);
  });

  it('extracts all fields correctly for first row', () => {
    const result = parsePsOutput(PS_FIXTURE);
    const first = result[0];
    assert.equal(first.pid, 1745);
    assert.equal(first.ppid, 735);
    assert.equal(first.rssKB, 328256);
    assert.equal(first.cpuPercent, 12.5);
    assert.equal(first.elapsed, '06:12:00');
    assert.equal(first.command, 'claude');
  });

  it('handles commands with spaces', () => {
    const result = parsePsOutput(PS_FIXTURE);
    const last = result[result.length - 1];
    assert.equal(last.command, 'grep something');
  });

  it('returns empty array for empty input', () => {
    const result = parsePsOutput('');
    assert.deepEqual(result, []);
  });
});

describe('getSystemMetrics', () => {
  it('returns system metrics with expected shape', () => {
    const metrics = getSystemMetrics();
    assert.equal(typeof metrics.totalRamGB, 'number');
    assert.equal(typeof metrics.usedRamGB, 'number');
    assert.equal(typeof metrics.availableRamGB, 'number');
    assert.equal(typeof metrics.claudeRamGB, 'number');
    assert.equal(typeof metrics.cpuLoadAvg1m, 'number');
    assert.equal(typeof metrics.cpuCores, 'number');
    assert.equal(typeof metrics.cpuLoadPercent, 'number');
    assert.ok(metrics.totalRamGB > 0);
    assert.ok(metrics.cpuCores > 0);
  });
});

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
