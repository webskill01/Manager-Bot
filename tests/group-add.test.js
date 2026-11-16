import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupManager } from '../core/groupManager.js';

test('direct add reads the per-person status: 403/409 are failures, not adds', async () => {
  const codes = { g1: '200', g2: '403', g3: '409' };
  const sock = { groupParticipantsUpdate: async (g, [jid]) => [{ status: codes[g], jid }], groupMetadata: async () => ({}) };
  const log = { info() {}, warn() {}, error() {} };
  const gm = createGroupManager(sock, { paidGroups: ['g1', 'g2', 'g3'], rateLimits: { groupOpGapMinMs: 0, groupOpGapMaxMs: 0 } }, log);
  const { added, failed } = await gm.rejoinAdd('9876543210', 'X');
  assert.deepEqual(added, ['g1']);
  assert.deepEqual(failed.map(f => f.reason), ['privacy_restricted', 'already_member']);
});
