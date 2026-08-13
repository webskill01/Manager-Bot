import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWatchdog } from '../scripts/watchdog.js';

// Fake bot: real HTTP server serving /health from a mutable state object and
// recording every /alert POST it receives.
function fakeBot({ connected = true, loggedOut = false, alertBroken = false, telegram = undefined } = {}) {
  const state = { connected, loggedOut, alertBroken, telegram };
  const alerts = [];
  const srv = http.createServer((req, res) => {
    if (state.alertBroken && req.url === '/alert') {
      // models a bot on ANOTHER VPS: healthy over its public host, but its
      // local alert port on this machine has nothing useful behind it
      res.statusCode = 404;
      return res.end();
    }
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: 'x', connected: state.connected, loggedOut: state.loggedOut,
        ...(state.telegram === undefined ? {} : { telegram: state.telegram }),
      }));
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

test('preferred sender is used even when listed after other healthy bots', async () => {
  const other = await fakeBot({ connected: true });
  const nitin = await fakeBot({ connected: true });
  const down = await fakeBot({ connected: false });
  try {
    const wd = createWatchdog(
      [
        { name: 'bot-2', port: other.port },       // healthy, listed first
        { name: 'bot-nitin', port: nitin.port },   // healthy, preferred
        { name: 'bot-abhi', port: down.port },
      ],
      { failThreshold: 1, log: silent, preferredSender: 'bot-nitin' },
    );
    await wd.tick();
    assert.equal(nitin.alerts.length, 1, 'alert delivered via preferred bot-nitin');
    assert.equal(other.alerts.length, 0, 'first-listed healthy bot skipped');
    assert.match(nitin.alerts[0], /🚨 \*bot-abhi\*/);

    // preferred sender goes down too → falls back to the other healthy bot
    nitin.state.connected = false;
    down.state.loggedOut = true;
    await wd.tick();
    assert.ok(other.alerts.length >= 1, 'fallback to another healthy bot when preferred is down');
  } finally {
    other.srv.close();
    nitin.srv.close();
    down.srv.close();
  }
});

test('relay falls through to the next candidate when the preferred bot is not on this machine', async () => {
  // preferred bot is healthy (health OK) but cannot relay locally (alert 404 —
  // i.e. it lives on the other VPS); the local healthy bot must deliver instead
  const remote = await fakeBot({ connected: true, alertBroken: true });
  const local = await fakeBot({ connected: true });
  const down = await fakeBot({ connected: false });
  try {
    const wd = createWatchdog(
      [
        { name: 'bot-nitin', port: remote.port },
        { name: 'bot-abhi', port: local.port },
        { name: 'bot-sachin2', port: down.port },
      ],
      { failThreshold: 1, log: silent, preferredSender: 'bot-nitin' },
    );
    await wd.tick();
    assert.equal(remote.alerts.length, 0, 'remote preferred bot cannot relay');
    assert.equal(local.alerts.length, 1, 'local bot delivered instead');
    assert.match(local.alerts[0], /🚨 \*bot-sachin2\*/);
    assert.equal(wd.pending.length, 0, 'nothing left queued');
  } finally {
    remote.srv.close();
    local.srv.close();
    down.srv.close();
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

// A dual-transport bot (bot-nitin) can still deliver over Telegram with its WhatsApp socket
// dead. That is the single most important alert in the system — "your number got flagged" —
// and before this it queued forever whenever the flagged bot was the only one on the box.
test('a dual bot relays its own logged-out alert over Telegram', async () => {
  const nitin = await fakeBot({ connected: false, loggedOut: true, telegram: true });
  try {
    const wd = createWatchdog([{ name: 'bot-nitin', port: nitin.port }], { failThreshold: 2, log: silent });
    await wd.tick();
    assert.equal(wd.pending.length, 0, 'the alert should have gone out, not queued');
    assert.equal(nitin.alerts.length, 1, 'a Telegram-capable bot was not used as a relay');
    assert.match(nitin.alerts[0], /LOGGED OUT/);
  } finally {
    nitin.srv.close();
  }
});

test('a WhatsApp-only bot with no connection still cannot relay — no false capability', async () => {
  const solo = await fakeBot({ connected: false, loggedOut: true });
  try {
    const wd = createWatchdog([{ name: 'A', port: solo.port }], { failThreshold: 2, log: silent });
    await wd.tick();
    assert.equal(solo.alerts.length, 0, 'a dead WhatsApp-only bot must not be treated as a sender');
    assert.ok(wd.pending.length >= 1, 'the alert must stay queued for a real sender');
  } finally {
    solo.srv.close();
  }
});
