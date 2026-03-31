// Alert detection logic for RAM protection
// Extracted for testability

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

module.exports = { detectAlerts };
