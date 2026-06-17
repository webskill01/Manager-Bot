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
  const engine = createTrialRemovalEngine(config, log, () => sock, () => []);

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
  const engine = createTrialRemovalEngine(config, log, () => sock, () => []);

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
