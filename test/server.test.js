const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

describe('server HTTP', () => {
  let server;
  const PORT = 4041;

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('serves static files on GET /', async () => {
    const { createServer } = require('../server');
    server = await createServer(PORT);
    const res = await fetch(`http://localhost:${PORT}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('Overwatch'));
  });

  it('returns 400 for invalid PID on kill endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill/abc`, { method: 'POST' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('returns 404 for non-existent PID on kill endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill/999999`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/kill-all-rogues', () => {
  let server;
  const PORT = 4043;

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('returns 400 when body.ports is missing', async () => {
    const { createServer } = require('../server');
    server = await createServer(PORT);
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('returns 400 when body.ports is empty array', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('returns 200 with results array (no match)', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports: [65530, 65531] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results.length, 2);
    data.results.forEach(r => {
      assert.ok('port' in r);
      assert.ok('ok' in r);
    });
  });
});

describe('server WebSocket', () => {
  let server;
  const PORT = 4042;

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('accepts WebSocket connections and sends initial payload', async () => {
    const { createServer } = require('../server');
    server = await createServer(PORT);

    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const message = await new Promise((resolve, reject) => {
      ws.on('message', data => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for WS message')), 10000);
    });

    assert.ok(message.current, 'should have current field');
    assert.ok(Array.isArray(message.history), 'should have history array');
    assert.ok(message.current.system, 'current should have system');
    assert.ok(Array.isArray(message.current.sessions), 'current should have sessions');
  });
});
