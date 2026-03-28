const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

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
