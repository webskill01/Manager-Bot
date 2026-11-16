import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appVerdict, sweepLists, requestPhone } from '../core/appGate.js';

const day = 864e5;
const row = (daysToExpiry, paidCount = 1) => ({
  status: daysToExpiry > 0 ? 'active' : 'expired', paidCount,
  expiresAt: new Date(Date.now() + daysToExpiry * day).toISOString(), lastPaidAt: '2026-11-01T00:00:00Z',
});

test('verdict: only paid + running is live; signups never count; 2-day grace after expiry', () => {
  assert.equal(appVerdict(row(10)), 'live');
  assert.equal(appVerdict(row(10, 0)), 'none');          // signed up / free plan, never paid
  assert.equal(appVerdict(null), 'none');                 // not on the app
  assert.equal(appVerdict(row(-0.1)), 'grace');          // ended today
  assert.equal(appVerdict(row(-1)), 'grace');            // ended yesterday
  assert.equal(appVerdict(row(-2)), 'expired');          // day 3 → removed
});

test('sweep: expired auto list skips own ACTIVE rows; admins/excluded/delayed never listed', () => {
  const rows = new Map([['1', row(-3)], ['2', row(-3)], ['3', row(5)], ['4', row(5, 0)], ['6', row(-3)], ['7', row(-3)], ['8', row(-1)]]);
  const out = sweepLists({
    appGroup: new Set(['1', '2', '3', '4', '5', '6', '7', '8']), rows,
    admins: new Set(['6']), exclude: new Set(['7']), delayed: new Set(), ownActive: new Set(['2']),
  });
  assert.deepEqual(out, { expired: ['1'], none: ['4', '5'] });
});

test('request phone: phone JID, else phone_number attr; bare LID → null', () => {
  assert.equal(requestPhone({ jid: '919876543210@s.whatsapp.net' }), '9876543210');
  assert.equal(requestPhone({ jid: '123@lid', phone_number: '919876543210@s.whatsapp.net' }), '9876543210');
  assert.equal(requestPhone({ jid: '123@lid' }), null);
});
