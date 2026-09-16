import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrialRemovalEngine } from '../core/trialRemovalEngine.js';

const log = { info() {}, warn() {}, error() {} };

function makeConfig(botDir) {
  return {
    botDir,
    trial: {
      groupId: 'trial@g.us',
      whitelist: ['9999999999'],
      batchSize: 10,
      batchesPerDay: { min: 1, max: 1 },
      messages: { warningText: 'hi' }, // no media path → sendBatchMessages just sends text + sleeps
    },
    allowedLids: [],
    rateLimits: { groupOpGapMinMs: 1, groupOpGapMaxMs: 1 },
  };
}

function writeState(botDir, batches, totalRemoved = 0) {
  fs.writeFileSync(path.join(botDir, 'trial-state.json'), JSON.stringify({
    active: true, startedAt: new Date().toISOString(), batches, totalRemoved,
  }));
}

async function waitFor(fn, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

test('removable participants are detected when Baileys exposes `id` (not `jid`)', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  const config = makeConfig(botDir);

  const removed = [];
  // Participants expose `id` only (no `jid`) — the field shape this fix is about. Before the fix,
  // isWhitelisted(undefined) returned true for all → removable empty → nobody removed.
  const participants = [
    { id: '918000000001@s.whatsapp.net' },
    { id: '918000000002@s.whatsapp.net' },
    { id: '919999999999@s.whatsapp.net' }, // whitelisted → must be kept
  ];
  const sock = {
    user: { id: 'me' },
    async groupMetadata() { return { participants: participants.filter(p => !removed.includes(p.id)) }; },
    async sendMessage() {},
    async groupParticipantsUpdate(_g, jids) { removed.push(jids[0]); },
  };
  const engine = createTrialRemovalEngine(config, log, () => sock, async () => {});

  // Overdue batch → scheduleFromState runs it at delay 0.
  writeState(botDir, [{ scheduledAt: new Date(Date.now() - 1000).toISOString(), done: false }]);
  engine.resume();

  const ok = await waitFor(() => removed.length === 2);
  assert.ok(ok, `expected 2 removals, got ${removed.length}`);
  assert.ok(!removed.includes('919999999999@s.whatsapp.net'), 'whitelisted member kept');

  engine.stopCommand();
  fs.rmSync(botDir, { recursive: true, force: true });
});

test('resume() never reprocesses an already-done batch', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  const config = makeConfig(botDir);

  let removeCalls = 0;
  const sock = {
    user: { id: 'me' },
    async groupMetadata() { return { participants: [{ id: '918000000001@s.whatsapp.net' }] }; },
    async sendMessage() {},
    async groupParticipantsUpdate() { removeCalls++; },
  };
  const engine = createTrialRemovalEngine(config, log, () => sock, async () => {});

  // Batch 0 already done + overdue; batch 1 still pending but an hour out (won't fire in-window).
  writeState(botDir, [
    { scheduledAt: new Date(Date.now() - 1000).toISOString(), done: true },
    { scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), done: false },
  ], 5);

  // Hammer resume() the way reconnects would — the done batch must never be re-run.
  for (let i = 0; i < 5; i++) engine.resume();
  await new Promise(r => setTimeout(r, 400));

  assert.equal(removeCalls, 0, 'done batch must not re-fire on resume');

  engine.stopCommand();
  fs.rmSync(botDir, { recursive: true, force: true });
});

test('the completion notice goes to the operator channel, never out over WhatsApp', async () => {
  // Regression guard for the 2:55 AM "Trial removal continuing" WhatsApp DMs: the socket is
  // for group ops and member reminders only, so every jid the engine writes to must be the
  // trial group. Anything the bot decides to say by itself belongs on Telegram.
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  const config = makeConfig(botDir);

  const sentTo = [];
  const notified = [];
  const removed = [];
  const sock = {
    user: { id: 'me' },
    async groupMetadata() {
      return { participants: [{ id: '918000000001@s.whatsapp.net' }].filter(p => !removed.includes(p.id)) };
    },
    async sendMessage(jid) { sentTo.push(jid); },
    async groupParticipantsUpdate(_g, jids) { removed.push(jids[0]); },
  };
  const engine = createTrialRemovalEngine(config, log, () => sock, async (t) => notified.push(t));

  writeState(botDir, [{ scheduledAt: new Date(Date.now() - 1000).toISOString(), done: false }]);
  engine.resume();

  const ok = await waitFor(() => notified.some(t => t.includes('Trial removal cycle complete')));
  assert.ok(ok, `completion notice never reached the operator channel: ${notified.join(' | ')}`);
  assert.deepEqual([...new Set(sentTo)], ['trial@g.us'], `WhatsApp send outside the group: ${sentTo.join(', ')}`);

  engine.stopCommand();
  fs.rmSync(botDir, { recursive: true, force: true });
});

// ── batch times start in the daytime and stay spread ───────────────────────────
//
// The old walk drew batch 1 uniformly across everything up to windowEnd − (count−1) × 90min
// — on a 5-batch cycle that is 10:00 to 16:00 — so most days opened in the afternoon with
// the whole morning unused, and the rest crowded into the evening. One slot per batch pins
// batch 1 to the first slot whatever the count.
test('the first batch lands in the first slot of the window, not the middle of the day', () => {
  const DAY = 24 * 60 * 60 * 1000, IST = 5.5 * 60 * 60 * 1000;
  const count = 5;
  for (let run = 0; run < 25; run++) {
    const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-times-'));
    const config = makeConfig(botDir);
    config.trial.batchesPerDay = { min: count, max: count };
    const now = Date.now();
    const engine = createTrialRemovalEngine(config, log, () => ({ user: { id: 'me' } }), async () => {});
    engine.start();
    const state = JSON.parse(fs.readFileSync(path.join(botDir, 'trial-state.json'), 'utf8'));
    engine.stopCommand();   // cancels the real 12-hour timers start() just armed
    const times = state.batches.map(b => new Date(b.scheduledAt).getTime());

    // The engine's own window, recomputed here: 10:00-22:00 IST, today or tomorrow.
    const midnight = now - ((now + IST) % DAY);
    let open = midnight + 10 * 3600e3, end = midnight + 22 * 3600e3;
    if (now >= end) { open += DAY; end += DAY; }
    const earliest = Math.max(open, now + 20 * 60e3);

    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] - times[i - 1] >= 90 * 60e3 - 1000, 'two batches landed inside 90 minutes');
    }
    assert.ok(times[times.length - 1] < end, 'a batch was scheduled past the window');
    if (times.length === count) {
      assert.ok(times[0] - earliest <= (end - earliest) / count,
        'batch 1 fell outside the first slot — the day opens late again');
    }
    fs.rmSync(botDir, { recursive: true, force: true });
  }
});
