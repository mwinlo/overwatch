const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectAlerts } = require('../alerts');

function makeSnapshot(ts, sessions, systemOverrides = {}) {
  return {
    timestamp: ts,
    system: {
      totalRamGB: 16,
      usedRamGB: 8,
      availableRamGB: 8,
      claudeRamGB: 2,
      ...systemOverrides,
    },
    sessions,
  };
}

function makeSession(pid, treeRssGB, label) {
  return { pid, treeRssGB, label: label || `session-${pid}`, cpuPercent: 5 };
}

describe('detectAlerts', () => {
  it('returns empty array when no previous snapshot', () => {
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2)]);
    assert.deepEqual(detectAlerts(current, null), []);
  });

  it('returns empty array when no sessions changed', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2)]);
    const alerts = detectAlerts(current, prev);
    assert.equal(alerts.length, 0);
  });

  it('detects RAM spike when rate exceeds threshold', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 4)]);
    // 2 GB in 3 seconds = 0.667 GB/s, above default 0.5
    const alerts = detectAlerts(current, prev);
    const spike = alerts.find(a => a.type === 'ram_spike');
    assert.ok(spike, 'should detect a ram_spike alert');
    assert.equal(spike.level, 'critical');
    assert.equal(spike.pid, 100);
    assert.ok(spike.rateGBPerSec > 0.5);
  });

  it('does not alert on slow RAM growth', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2.1)]);
    // 0.1 GB in 3s = 0.033 GB/s, well below threshold
    const alerts = detectAlerts(current, prev);
    assert.equal(alerts.filter(a => a.type === 'ram_spike').length, 0);
  });

  it('detects RAM ceiling breach', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 10)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 13)]);
    // 13 GB on 16 GB system = 81.25%, above 80% default ceiling
    const alerts = detectAlerts(current, prev);
    const ceiling = alerts.find(a => a.type === 'ram_ceiling');
    assert.ok(ceiling, 'should detect ram_ceiling alert');
    assert.equal(ceiling.pid, 100);
  });

  it('does not alert when below ceiling', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 5)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 5)]);
    const alerts = detectAlerts(current, prev);
    assert.equal(alerts.filter(a => a.type === 'ram_ceiling').length, 0);
  });

  it('detects low system RAM', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)], { availableRamGB: 3 });
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2)], { availableRamGB: 1.5 });
    const alerts = detectAlerts(current, prev);
    const lowRam = alerts.find(a => a.type === 'low_ram');
    assert.ok(lowRam, 'should detect low_ram alert');
    assert.equal(lowRam.level, 'warning');
  });

  it('respects custom threshold options', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2.5)]);
    // 0.5 GB in 3s = 0.167 GB/s — below default 0.5 but above custom 0.1
    const alerts = detectAlerts(current, prev, { spikeGBPerSec: 0.1 });
    assert.ok(alerts.some(a => a.type === 'ram_spike'));
  });

  it('annotates sessions with ramRateGBs', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const session = makeSession(100, 3);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [session]);
    detectAlerts(current, prev);
    assert.equal(typeof session.ramRateGBs, 'number');
    assert.ok(session.ramRateGBs > 0);
  });

  it('handles new sessions not in previous snapshot', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2), makeSession(200, 5)]);
    // Session 200 is new — should not crash, no rate info available
    const alerts = detectAlerts(current, prev);
    assert.ok(!alerts.some(a => a.pid === 200 && a.type === 'ram_spike'));
  });

  it('can fire multiple alert types simultaneously', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 10)], { availableRamGB: 3 });
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 14)], { availableRamGB: 1 });
    // spike: 4GB/3s = 1.33 GB/s, ceiling: 14/16 = 87.5%, low_ram: 1GB free
    const alerts = detectAlerts(current, prev);
    assert.ok(alerts.some(a => a.type === 'ram_spike'));
    assert.ok(alerts.some(a => a.type === 'ram_ceiling'));
    assert.ok(alerts.some(a => a.type === 'low_ram'));
  });
});
