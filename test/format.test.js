const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatUptime } = require('../public/format.js');

describe('formatUptime', () => {
  it('returns em-dash for falsy input', () => {
    assert.equal(formatUptime(null), '\u2014');
    assert.equal(formatUptime(''), '\u2014');
    assert.equal(formatUptime(undefined), '\u2014');
  });

  it('formats MM:SS as "Xm Ys"', () => {
    assert.equal(formatUptime('05:23'), '5m 23s');
    assert.equal(formatUptime('00:45'), '45s');
    assert.equal(formatUptime('12:00'), '12m');
  });

  it('formats HH:MM:SS as "Xh Ym"', () => {
    assert.equal(formatUptime('01:30:00'), '1h 30m');
    assert.equal(formatUptime('21:32:29'), '21h 32m');
    assert.equal(formatUptime('00:05:00'), '5m');
  });

  it('formats DD-HH:MM:SS as "Xd Yh" when days > 0', () => {
    assert.equal(formatUptime('01-06:26:03'), '1d 6h');
    assert.equal(formatUptime('03-00:00:00'), '3d');
    assert.equal(formatUptime('10-12:34:56'), '10d 12h');
  });

  it('returns raw string unchanged for unparseable input', () => {
    assert.equal(formatUptime('bogus'), 'bogus');
    assert.equal(formatUptime('?'), '?');
  });
});
