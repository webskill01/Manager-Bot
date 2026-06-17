import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGhostRemovalEngine } from '../core/ghostRemovalEngine.js';

const log = { info() {}, warn() {}, error() {} };

function makeConfig(botDir) {
  return {
    botDir,
    paidGroups: ['g1@g.us', 'g2@g.us'],
    allowedNumbers: [],
    auditExclude: [],
    rateLimits: { groupOpGapMinMs: 1, groupOpGapMaxMs: 1 },
  };
}

// Empty sheet → every group participant is a ghost.
function makeStore() {
  return {
    async refresh() {},
    getAll() { return []; },
    findByPhone() { return null; },
  };
}

test('a ghost interrupted by socket loss mid-removal is NOT marked done (stays retryable)', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-'));
  const config = makeConfig(botDir);

  // Socket alive through the scan + first group removal, then drops so the loop is interrupted.
  let removedOne = false;
  const sock = {
    get user() { return removedOne ? null : { id: 'me' }; },
    async groupMetadata() { return { participants: [{ id: '919000000001@s.whatsapp.net' }] }; },
    async groupParticipantsUpdate() { removedOne = true; },
  };
  const engine = createGhostRemovalEngine(config, log, () => sock, makeStore(), () => []);

  await engine.start();
  await new Promise(r => setTimeout(r, 200));

  // Interrupted → the run is still active with 0 marked done, so resume() will retry it later.
  const st = engine.status();
  assert.ok(st, 'run should still be active after an interrupted removal');
  assert.equal(st.done, 0, 'interrupted ghost must not be counted done');

  engine.stop();
  fs.rmSync(botDir, { recursive: true, force: true });
});

test('two quick "kickghosts confirm" calls only start one run', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-'));
  const config = makeConfig(botDir);
  const sock = {
    user: { id: 'me' },
    async groupMetadata() { return { participants: [{ id: '919000000001@s.whatsapp.net' }] }; },
    async groupParticipantsUpdate() {},
  };
  const engine = createGhostRemovalEngine(config, log, () => sock, makeStore(), () => []);

  const [a, b] = await Promise.all([engine.start(), engine.start()]);
  const started = [a, b].filter(m => /started/i.test(m));
  const blocked = [a, b].filter(m => /already running/i.test(m));
  assert.equal(started.length, 1, 'exactly one call starts the run');
  assert.equal(blocked.length, 1, 'the racing call is rejected');

  engine.stop();
  fs.rmSync(botDir, { recursive: true, force: true });
});
