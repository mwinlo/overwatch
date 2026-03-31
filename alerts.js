// Alert detection logic for RAM protection
// Extracted for testability

/**
 * Detect sessions on a runaway growth trajectory.
 * growthTracker: Map<pid, Array<{timestamp: string, treeRssGB: number}>>
 * Returns array of runaway alerts with projected time-to-ceiling.
 */
function detectRunaway(current, growthTracker, opts = {}) {
  const ceilingPct = opts.ceilingPct || 80;
  const horizonSec = opts.runawayHorizonSec || 120; // alert if ceiling hit within 2 min
  const minSamples = opts.runawayMinSamples || 5;   // need at least 5 data points
  const ceilingGB = current.system.totalRamGB * (ceilingPct / 100);
  const runawayAlerts = [];

  for (const session of current.sessions) {
    const samples = growthTracker.get(session.pid);
    if (!samples || samples.length < minSamples) continue;

    // Already at or above ceiling — ram_ceiling handles that
    if (session.treeRssGB >= ceilingGB) continue;

    // Linear regression over the window: average rate of growth
    const first = samples[0];
    const last = samples[samples.length - 1];
    const windowSec = (new Date(last.timestamp) - new Date(first.timestamp)) / 1000;
    if (windowSec <= 0) continue;

    const growthGB = last.treeRssGB - first.treeRssGB;
    const rateGBPerSec = growthGB / windowSec;

    // Only alert on positive growth
    if (rateGBPerSec <= 0) continue;

    const remainingGB = ceilingGB - session.treeRssGB;
    const secToCeiling = remainingGB / rateGBPerSec;

    // Annotate the session with projection data
    session.projectedSecToCeiling = Math.round(secToCeiling);
    session.avgGrowthRateGBs = Math.round(rateGBPerSec * 1000) / 1000;

    if (secToCeiling <= horizonSec) {
      const minToCeiling = secToCeiling < 60
        ? `${Math.round(secToCeiling)}s`
        : `${(secToCeiling / 60).toFixed(1)}m`;

      runawayAlerts.push({
        level: 'warning',
        type: 'ram_runaway',
        pid: session.pid,
        label: session.label,
        message: `${session.label} (PID ${session.pid}): runaway growth +${rateGBPerSec.toFixed(3)} GB/s — ceiling in ${minToCeiling}`,
        rateGBPerSec,
        secToCeiling: Math.round(secToCeiling),
      });
    }
  }

  return runawayAlerts;
}

/**
 * Detect rapid burst growth over a short window (3+ polls).
 * Catches the middle ground: too fast to wait for runaway, but each
 * individual poll is under the single-poll spike threshold.
 */
function detectBurst(current, growthTracker, opts = {}) {
  const burstGBPerSec = opts.burstGBPerSec || 0.2;   // avg rate over short window
  const burstMinSamples = opts.burstMinSamples || 3;  // fires faster than runaway
  const burstAlerts = [];

  for (const session of current.sessions) {
    const samples = growthTracker.get(session.pid);
    if (!samples || samples.length < burstMinSamples) continue;

    // Use the last burstMinSamples entries (short window)
    const window = samples.slice(-burstMinSamples);
    const first = window[0];
    const last = window[window.length - 1];
    const windowSec = (new Date(last.timestamp) - new Date(first.timestamp)) / 1000;
    if (windowSec <= 0) continue;

    const growthGB = last.treeRssGB - first.treeRssGB;
    const avgRate = growthGB / windowSec;

    if (avgRate >= burstGBPerSec) {
      burstAlerts.push({
        level: 'critical',
        type: 'ram_burst',
        pid: session.pid,
        label: session.label,
        message: `${session.label} (PID ${session.pid}): RAM burst +${growthGB.toFixed(2)} GB in ${Math.round(windowSec)}s (${avgRate.toFixed(2)} GB/s avg)`,
        avgRateGBPerSec: Math.round(avgRate * 1000) / 1000,
        growthGB: Math.round(growthGB * 1000) / 1000,
        windowSec: Math.round(windowSec),
      });
    }
  }

  return burstAlerts;
}

function detectAlerts(current, prev, opts = {}) {
  const spikeThreshold = opts.spikeGBPerSec || 0.5;
  const ceilingPct = opts.ceilingPct || 80;
  const pressureFreeGB = opts.pressureFreeGB || 2;

  const newAlerts = [];
  if (!prev) return newAlerts;

  const elapsedSec = (new Date(current.timestamp) - new Date(prev.timestamp)) / 1000;
  if (elapsedSec <= 0) return newAlerts;

  for (const session of current.sessions) {
    const prevSession = prev.sessions.find(s => s.pid === session.pid);
    if (!prevSession) continue;

    const deltaGB = session.treeRssGB - prevSession.treeRssGB;
    const rateGBPerSec = deltaGB / elapsedSec;
    session.ramRateGBs = Math.round(rateGBPerSec * 1000) / 1000;

    // Spike alert: RAM accelerating dangerously
    if (rateGBPerSec >= spikeThreshold) {
      newAlerts.push({
        level: 'critical',
        type: 'ram_spike',
        pid: session.pid,
        label: session.label,
        message: `${session.label} (PID ${session.pid}): RAM surging +${rateGBPerSec.toFixed(2)} GB/s`,
        rateGBPerSec,
      });
    }

    // Ceiling alert: session exceeding RAM ceiling
    const ceilingGB = current.system.totalRamGB * (ceilingPct / 100);
    if (session.treeRssGB >= ceilingGB) {
      newAlerts.push({
        level: 'critical',
        type: 'ram_ceiling',
        pid: session.pid,
        label: session.label,
        message: `${session.label} (PID ${session.pid}): ${session.treeRssGB} GB exceeds ${ceilingPct}% ceiling (${ceilingGB.toFixed(1)} GB)`,
      });
    }
  }

  // Session exited detection: sessions in prev but missing from current
  const currentPids = new Set(current.sessions.map(s => s.pid));
  for (const prevSession of prev.sessions) {
    if (!currentPids.has(prevSession.pid)) {
      newAlerts.push({
        level: 'warning',
        type: 'session_exited',
        pid: prevSession.pid,
        label: prevSession.label,
        message: `${prevSession.label} (PID ${prevSession.pid}) exited`,
        exitedSession: {
          pid: prevSession.pid,
          label: prevSession.label,
          workingDir: prevSession.workingDir,
          treeRssGB: prevSession.treeRssGB,
          elapsed: prevSession.elapsed,
        },
      });
    }
  }

  // System pressure alert
  if (current.system.availableRamGB < pressureFreeGB) {
    newAlerts.push({
      level: 'warning',
      type: 'low_ram',
      message: `System RAM critically low: ${current.system.availableRamGB} GB free`,
    });
  }

  return newAlerts;
}

module.exports = { detectAlerts, detectRunaway, detectBurst };
