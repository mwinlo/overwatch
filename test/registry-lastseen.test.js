const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../registry');

describe('registry lastSeen tracking', () => {
  beforeEach(() => { registry._resetLastSeen(); });

  it('records timestamp when touched', () => {
    const before = Date.now();
    registry.touchLastSeen('alpha');
    const ts = registry.getLastSeen('alpha');
    assert.ok(ts >= before);
    assert.ok(ts <= Date.now());
  });

  it('returns null for unknown project', () => {
    assert.equal(registry.getLastSeen('nonexistent'), null);
  });

  it('updates on repeated calls', async () => {
    registry.touchLastSeen('beta');
    const first = registry.getLastSeen('beta');
    await new Promise(r => setTimeout(r, 10));
    registry.touchLastSeen('beta');
    const second = registry.getLastSeen('beta');
    assert.ok(second > first);
  });
});
