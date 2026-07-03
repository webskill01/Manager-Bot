import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWatchdog } from '../scripts/watchdog.js';

// Fake bot: real HTTP server serving /health from a mutable state object and
// recording every /alert POST it receives.
function fakeBot({ connected = true, loggedOut = false } = {}) {
  const state = { connected, loggedOut };
  const alerts = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'x', connected: state.connected, loggedOut: state.loggedOut }));
    } else if (req.url === '/alert' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        alerts.push(JSON.parse(body).text);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sent: true }));
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, alerts, port: srv.address().port })),
  );
}

const silent = { warn() {}, log() {} };

test('down bot alerts after threshold, via the healthy bot, then recovery alert', async () => {
  const a = await fakeBot({ connected: true });
  const b = await fakeBot({ connected: false });
  try {
    const wd = createWatchdog(
      [{ name: 'A', port: a.port }, { name: 'B', port: b.port }],
      { failThreshold: 2, log: silent },
    );

    await wd.tick(); // fail 1 — below threshold
    assert.equal(a.alerts.length, 0, 'no alert before threshold');

    await wd.tick(); // fail 2 — alert fires, delivered via A
    assert.equal(a.alerts.length, 1);
    assert.match(a.alerts[0], /🚨 \*B\* is disconnected/);

    await wd.tick(); // still down — no duplicate alert
    assert.equal(a.alerts.length, 1, 'down alert fires only once');

    b.state.connected = true;
    await wd.tick(); // recovery
    assert.equal(a.alerts.length, 2);
    assert.match(a.alerts[1], /✅ \*B\* is healthy again/);
  } finally {
    a.srv.close();
    b.srv.close();
  }
});

test('unreachable bot (no server at all) alerts as not responding', async () => {
  const a = await fakeBot({ connected: true });
  const dead = await fakeBot();
  const deadPort = dead.port;
  await new Promise((r) => dead.srv.close(r)); // port now refuses connections
  try {
    const wd = createWatchdog(
      [{ name: 'A', port: a.port }, { name: 'B', port: deadPort }],
      { failThreshold: 2, log: silent },
    );
    await wd.tick();
    await wd.tick();
    assert.equal(a.alerts.length, 1);
    assert.match(a.alerts[0], /🚨 \*B\* is not responding/);
  } finally {
    a.srv.close();
  }
});

test('logged-out alerts immediately and only once', async () => {
  const a = await fakeBot({ connected: true });
  const b = await fakeBot({ connected: false, loggedOut: true });
  try {
    const wd = createWatchdog(
      [{ name: 'A', port: a.port }, { name: 'B', port: b.port }],
      { failThreshold: 3, log: silent },
    );
    await wd.tick(); // immediate — does not wait for failThreshold
    assert.equal(a.alerts.length, 1);
    assert.match(a.alerts[0], /🚨 \*B\* is LOGGED OUT/);
    await wd.tick();
    assert.equal(a.alerts.length, 1, 'logged-out alert fires only once');
  } finally {
    a.srv.close();
    b.srv.close();
  }
});

test('no healthy sender: alerts queue and flush when a bot recovers', async () => {
  const a = await fakeBot({ connected: false });
  const b = await fakeBot({ connected: false, loggedOut: true });
  try {
    const wd = createWatchdog(
      [{ name: 'A', port: a.port }, { name: 'B', port: b.port }],
      { failThreshold: 2, log: silent },
    );
    await wd.tick();
    await wd.tick();
    assert.equal(a.alerts.length + b.alerts.length, 0, 'nothing deliverable yet');
    assert.ok(wd.pending.length >= 1, 'alerts queued while no sender available');

    a.state.connected = true;
    await wd.tick(); // A recovers → queued alerts flush through A
    assert.ok(a.alerts.length >= 1, 'queued alerts delivered after recovery');
    assert.equal(wd.pending.length, 0, 'queue drained');
    assert.ok(a.alerts.some((t) => /LOGGED OUT/.test(t)), 'logged-out alert survived the queue');
  } finally {
    a.srv.close();
    b.srv.close();
  }
});
