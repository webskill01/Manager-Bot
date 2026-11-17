import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appVerdict, sweepLists, requestPhone } from '../core/appGate.js';

const day = 864e5;
const row = (daysToExpiry, paidCount = 1) => ({
  status: daysToExpiry > 0 ? 'active' : 'expired', paidCount,
  expiresAt: new Date(Date.now() + daysToExpiry * day).toISOString(), lastPaidAt: '2026-11-01T00:00:00Z',
});

test('verdict: active membership is live whether paid on app or given by hand; 2-day grace', () => {
  assert.equal(appVerdict(row(10)), 'live');
  assert.equal(appVerdict(row(10, 0)), 'live');          // plan given by hand (paid operator directly)
  assert.equal(appVerdict({ status: 'pending' }), 'none'); // signed up, no membership
  assert.equal(appVerdict(null), 'none');                 // not on the app
  assert.equal(appVerdict(row(-3, 0)), 'expired');       // hand-given plan ended → swept too
  assert.equal(appVerdict(row(-0.1)), 'grace');          // ended today
  assert.equal(appVerdict(row(-1)), 'grace');            // ended yesterday
  assert.equal(appVerdict(row(-2)), 'expired');          // day 3 → removed
});

test('sweep: expired auto list skips own ACTIVE rows; admins/excluded/delayed never listed', () => {
  const rows = new Map([['1', row(-3)], ['2', row(-3)], ['3', row(5)], ['4', { status: 'pending' }], ['6', row(-3)], ['7', row(-3)], ['8', row(-1)], ['9', row(5, 0)]]);
  const out = sweepLists({
    appGroup: new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']), rows,
    admins: new Set(['6']), exclude: new Set(['7']), delayed: new Set(), ownActive: new Set(['2']),
  });
  assert.deepEqual(out, { expired: ['1'], none: ['4', '5'] });
});

test('request phone: phone JID, else phone_number attr; bare LID → null', () => {
  assert.equal(requestPhone({ jid: '919876543210@s.whatsapp.net' }), '9876543210');
  assert.equal(requestPhone({ jid: '123@lid', phone_number: '919876543210@s.whatsapp.net' }), '9876543210');
  assert.equal(requestPhone({ jid: '123@lid' }), null);
});

test('gate: paid but no DM yet → left pending and reported; with DM → approved; unpaid → rejected', async () => {
  const { createAppGate } = await import('../core/appGate.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  fs.writeFileSync(path.join(dir, 'app-gate.json'), JSON.stringify({ active: true, queue: [], pendingNone: [] }));
  const acted = [], notes = [];
  const sock = {
    user: { id: '1' },
    groupRequestParticipantsList: async () => ['9000000001', '9000000002', '9000000003'].map(p => ({ jid: `91${p}@s.whatsapp.net` })),
    groupRequestParticipantsUpdate: async (g, [jid], action) => acted.push(`${action} ${jid.slice(2, 12)}`),
  };
  const gate = createAppGate({
    config: { botDir: dir, appGroupId: 'g', appGate: {} }, log: { info() {}, warn() {} }, getSock: () => sock,
    appSync: { lookup: async (p) => (p === '9000000003' ? null : row(10, p === '9000000001' ? 0 : 1)) },   // 01 = hand-given plan
    notify: async (t) => notes.push(t), hasDm: (p) => p === '9000000001',
  });
  const orig = global.setTimeout; global.setTimeout = (fn) => orig(fn, 0);   // skip the 4–8 s gaps
  try { await gate.gateRequests(); } finally { global.setTimeout = orig; }
  assert.deepEqual(acted, ['approve 9000000001', 'reject 9000000003']);
  assert.match(notes[0], /waiting for their DM.*9000000002/);
});
