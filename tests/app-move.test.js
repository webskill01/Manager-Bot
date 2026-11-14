import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCandidates } from '../core/appMoveEngine.js';

const future = new Date(Date.now() + 10 * 864e5).toISOString();
const live = (phone) => ({ phone, status: 'active', expiresAt: future, paidCount: 1, lastPaidAt: '2026-11-01T00:00:00Z' });

test('candidates: in app group AND a paid group AND live on app, minus admins/excluded/done', () => {
  const groups = { '9000000001': ['g1'], '9000000002': ['g1', 'g2'], '9000000003': ['g1'], '9000000004': ['g1'], '9000000005': ['g2'], '9000000006': ['g1'] };
  const args = {
    phonesInPaid: Object.keys(groups),
    groupsOf: (p) => groups[p] || [],
    appGroup: new Set(['9000000001', '9000000002', '9000000004', '9000000005', '9000000006']),
    admins: new Set(['9000000005']),
    snapshot: new Map(['9000000001', '9000000002', '9000000003', '9000000005', '9000000006'].map(p => [p, live(p)])
      .concat([['9000000004', { ...live('9000000004'), paidCount: 0 }]])),
    exclude: new Set(['9000000006']),
    done: { '9000000002': 200 },
    scanAt: 100,
  };
  // 3 not in app group, 4 not paying, 5 admin, 6 excluded, 2 already moved since this scan
  assert.deepEqual(moveCandidates(args), ['9000000001']);
  // a newer scan still showing 2 in a paid group makes them a candidate again
  assert.deepEqual(moveCandidates({ ...args, scanAt: 300 }), ['9000000001', '9000000002']);
});
