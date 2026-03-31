const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectAlerts, detectRunaway, detectBurst } = require('../alerts');

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

  it('detects session that exited between polls', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [
      makeSession(100, 2, 'my-project'),
      makeSession(200, 3, 'other-project'),
    ]);
    // Session 200 disappeared
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2, 'my-project')]);
    const alerts = detectAlerts(current, prev);
    const exited = alerts.find(a => a.type === 'session_exited');
    assert.ok(exited, 'should detect session_exited alert');
    assert.equal(exited.level, 'warning');
    assert.equal(exited.pid, 200);
    assert.equal(exited.label, 'other-project');
    assert.ok(exited.exitedSession, 'should include exitedSession snapshot');
    assert.equal(exited.exitedSession.treeRssGB, 3);
  });

  it('does not fire session_exited for sessions still running', () => {
    const prev = makeSnapshot('2025-01-01T00:00:00Z', [makeSession(100, 2)]);
    const current = makeSnapshot('2025-01-01T00:00:03Z', [makeSession(100, 2)]);
    const alerts = detectAlerts(current, prev);
    assert.equal(alerts.filter(a => a.type === 'session_exited').length, 0);
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

describe('detectRunaway', () => {
  function makeSamples(pid, startGB, rateGBPerSec, count, intervalSec) {
    // Generate a growth trajectory: count samples at intervalSec apart
    const samples = [];
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    for (let i = 0; i < count; i++) {
      samples.push({
        timestamp: new Date(base + i * intervalSec * 1000).toISOString(),
        treeRssGB: Math.round((startGB + rateGBPerSec * i * intervalSec) * 1000) / 1000,
      });
    }
    return samples;
  }

  it('detects runaway session projected to hit ceiling', () => {
    // 16GB system, 80% ceiling = 12.8 GB
    // Session at 10 GB, growing 0.1 GB/s → ceiling in 28s
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 7, 0.1, 10, 3)); // 7 → 9.7 over 27s
    const current = makeSnapshot('2025-01-01T00:00:27Z', [
      { pid: 100, treeRssGB: 10, label: 'runaway-proj', cpuPercent: 50 },
    ]);
    const alerts = detectRunaway(current, tracker, { ceilingPct: 80, runawayHorizonSec: 120 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'ram_runaway');
    assert.equal(alerts[0].pid, 100);
    assert.ok(alerts[0].secToCeiling > 0 && alerts[0].secToCeiling <= 120);
    assert.ok(alerts[0].message.includes('runaway growth'));
  });

  it('does not alert when growth is too slow to hit ceiling within horizon', () => {
    // Session at 2 GB, growing 0.001 GB/s → ceiling in 10,800s (~3h)
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 1.7, 0.001, 10, 3));
    const current = makeSnapshot('2025-01-01T00:00:27Z', [
      { pid: 100, treeRssGB: 2, label: 'slow-proj', cpuPercent: 5 },
    ]);
    const alerts = detectRunaway(current, tracker, { ceilingPct: 80, runawayHorizonSec: 120 });
    assert.equal(alerts.length, 0);
  });

  it('does not alert when memory is shrinking', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 8, -0.05, 10, 3)); // shrinking
    const current = makeSnapshot('2025-01-01T00:00:27Z', [
      { pid: 100, treeRssGB: 6.5, label: 'shrink-proj', cpuPercent: 5 },
    ]);
    const alerts = detectRunaway(current, tracker, { ceilingPct: 80 });
    assert.equal(alerts.length, 0);
  });

  it('does not alert with fewer samples than minimum', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 10, 0.5, 3, 3)); // only 3 samples
    const current = makeSnapshot('2025-01-01T00:00:06Z', [
      { pid: 100, treeRssGB: 11, label: 'new-proj', cpuPercent: 50 },
    ]);
    const alerts = detectRunaway(current, tracker, { ceilingPct: 80, runawayMinSamples: 5 });
    assert.equal(alerts.length, 0);
  });

  it('skips sessions already at or above ceiling', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 12, 0.1, 10, 3));
    const current = makeSnapshot('2025-01-01T00:00:27Z', [
      { pid: 100, treeRssGB: 13, label: 'over-proj', cpuPercent: 50 },
    ]);
    // 13 GB > 12.8 GB ceiling — ram_ceiling handles this, not runaway
    const alerts = detectRunaway(current, tracker, { ceilingPct: 80 });
    assert.equal(alerts.length, 0);
  });

  it('annotates session with projectedSecToCeiling and avgGrowthRateGBs', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 7, 0.1, 10, 3));
    const session = { pid: 100, treeRssGB: 10, label: 'proj', cpuPercent: 50 };
    const current = makeSnapshot('2025-01-01T00:00:27Z', [session]);
    detectRunaway(current, tracker, { ceilingPct: 80, runawayHorizonSec: 120 });
    assert.equal(typeof session.projectedSecToCeiling, 'number');
    assert.ok(session.projectedSecToCeiling > 0);
    assert.equal(typeof session.avgGrowthRateGBs, 'number');
    assert.ok(session.avgGrowthRateGBs > 0);
  });
});

describe('detectBurst', () => {
  function makeSamples(pid, startGB, rateGBPerSec, count, intervalSec) {
    const samples = [];
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    for (let i = 0; i < count; i++) {
      samples.push({
        timestamp: new Date(base + i * intervalSec * 1000).toISOString(),
        treeRssGB: Math.round((startGB + rateGBPerSec * i * intervalSec) * 1000) / 1000,
      });
    }
    return samples;
  }

  it('detects burst when avg rate over short window exceeds threshold', () => {
    // 0.3 GB/s avg over 3 polls (9s) — under single-poll spike (0.5) but over burst (0.2)
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 4, 0.3, 3, 3));
    const current = makeSnapshot('2025-01-01T00:00:06Z', [
      { pid: 100, treeRssGB: 5.8, label: 'burst-proj', cpuPercent: 80 },
    ]);
    const alerts = detectBurst(current, tracker, { burstGBPerSec: 0.2 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'ram_burst');
    assert.equal(alerts[0].level, 'critical');
    assert.equal(alerts[0].pid, 100);
    assert.ok(alerts[0].avgRateGBPerSec >= 0.2);
    assert.ok(alerts[0].growthGB > 0);
    assert.ok(alerts[0].windowSec > 0);
    assert.ok(alerts[0].message.includes('burst'));
  });

  it('does not alert when avg rate is below threshold', () => {
    // 0.1 GB/s avg — below 0.2 threshold
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 4, 0.1, 3, 3));
    const current = makeSnapshot('2025-01-01T00:00:06Z', [
      { pid: 100, treeRssGB: 4.6, label: 'slow-proj', cpuPercent: 10 },
    ]);
    const alerts = detectBurst(current, tracker, { burstGBPerSec: 0.2 });
    assert.equal(alerts.length, 0);
  });

  it('does not alert with fewer samples than minimum', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 4, 0.5, 2, 3)); // only 2 samples
    const current = makeSnapshot('2025-01-01T00:00:03Z', [
      { pid: 100, treeRssGB: 5.5, label: 'new-proj', cpuPercent: 80 },
    ]);
    const alerts = detectBurst(current, tracker, { burstGBPerSec: 0.2, burstMinSamples: 3 });
    assert.equal(alerts.length, 0);
  });

  it('does not alert when memory is flat or shrinking', () => {
    const tracker = new Map();
    tracker.set(100, makeSamples(100, 5, 0, 3, 3));       // flat
    tracker.set(200, makeSamples(200, 5, -0.1, 3, 3));    // shrinking
    const current = makeSnapshot('2025-01-01T00:00:06Z', [
      { pid: 100, treeRssGB: 5, label: 'flat-proj', cpuPercent: 5 },
      { pid: 200, treeRssGB: 4.4, label: 'shrink-proj', cpuPercent: 5 },
    ]);
    const alerts = detectBurst(current, tracker, { burstGBPerSec: 0.2 });
    assert.equal(alerts.length, 0);
  });

  it('uses only the last burstMinSamples entries', () => {
    // 10 samples: first 7 are flat, last 3 have a burst
    const tracker = new Map();
    const flatSamples = makeSamples(100, 4, 0, 7, 3);          // 4 GB flat for 7 polls
    const burstSamples = makeSamples(100, 4, 0.4, 3, 3);       // then 0.4 GB/s for 3 polls
    // Adjust burst timestamps to continue after flat
    const burstStart = new Date('2025-01-01T00:00:21Z').getTime();
    burstSamples.forEach((s, i) => {
      s.timestamp = new Date(burstStart + i * 3000).toISOString();
    });
    tracker.set(100, [...flatSamples, ...burstSamples]);
    const current = makeSnapshot('2025-01-01T00:00:27Z', [
      { pid: 100, treeRssGB: 6.4, label: 'late-burst', cpuPercent: 70 },
    ]);
    const alerts = detectBurst(current, tracker, { burstGBPerSec: 0.2, burstMinSamples: 3 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'ram_burst');
  });
});
