const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseVmStat, parseLoadAvg, parsePsOutput, getSystemMetrics } = require('../monitor');

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
