// refreshlinks fired all 12 groupInviteCode calls back-to-back on its first outing and
// WhatsApp answered rate-overlimit for the tail. It must pace itself like every other
// group loop, and survive a limiter that is already warm from a previous command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupManager } from '../core/groupManager.js';

const log = { info() {}, warn() {}, error() {} };
const GROUPS = Array.from({ length: 12 }, (_, i) => `${i}@g.us`);

// Tiny gaps keep the test fast; what matters is that a gap happens at all.
const config = {
  paidGroups: GROUPS,
  rateLimits: { groupOpGapMinMs: 10, groupOpGapMaxMs: 12, batchCooldownMs: 0 },
};

test('every call after the first is preceded by a gap', async () => {
  const at = [];
  const sock = { async groupInviteCode(id) { at.push(Date.now()); return `CODE${id[0]}`; } };
  const gm = createGroupManager(sock, config, log);

  const { fetched, failed } = await gm.getAllInviteLinks();
  assert.equal(fetched.length, 12);
  assert.equal(failed.length, 0);
  assert.equal(at.length, 12, 'one call per group, no groupMetadata round trip');

  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.equal(gaps.length, 11);
  assert.ok(gaps.every(g => g >= 8), `unpaced call found — gaps ${gaps.join(',')}`);
});

test('a rate-limited group is retried once, then succeeds', async () => {
  const tries = {};
  const sock = {
    async groupInviteCode(id) {
      tries[id] = (tries[id] || 0) + 1;
      if (id === '5@g.us' && tries[id] === 1) throw new Error('rate-overlimit');
      return `CODE${id[0]}`;
    },
  };
  // Retry backoff is 20-30s in production; the test only asserts the retry happens.
  const gm = createGroupManager(sock, { ...config, rateLimits: { ...config.rateLimits } }, log);
  const { fetched, failed } = await gm.getAllInviteLinks();

  assert.equal(tries['5@g.us'], 2, 'the rate-limited group was retried');
  assert.equal(failed.length, 0, 'retry recovered it');
  assert.equal(fetched.length, 12);
});

test('a group that fails for a non-rate reason is not retried, and does not sink the rest', async () => {
  const tries = {};
  const sock = {
    async groupInviteCode(id) {
      tries[id] = (tries[id] || 0) + 1;
      if (id === '3@g.us') throw new Error('not-authorized');
      return `CODE${id[0]}`;
    },
  };
  const gm = createGroupManager(sock, config, log);
  const { fetched, failed } = await gm.getAllInviteLinks();

  assert.equal(tries['3@g.us'], 1, 'no point retrying a permission error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].groupId, '3@g.us');
  assert.equal(failed[0].index, 4, 'index is 1-based, matching what setlink takes');
  assert.equal(fetched.length, 11, 'the other eleven still came back');
});

test('a concurrent refresh queues instead of doubling the call rate', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sock = {
    async groupInviteCode(id) {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return `CODE${id[0]}`;
    },
  };
  const gm = createGroupManager(sock, config, log);
  await Promise.all([gm.getAllInviteLinks(), gm.getAllInviteLinks()]);
  assert.equal(maxInFlight, 1, 'two refreshes must not interleave — that is what tripped the limiter');
});
