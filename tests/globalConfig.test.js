import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampedBillingDate, nextBillingForDay, formatDate, parseDate, daysFromToday,
  renewedOn, isPaidJoin, pickSurplusReferrals, surplusCreditDate,
  getReferralsInBillingPeriod,
} from '../core/globalConfig.js';

test('clampedBillingDate clamps day to month length', () => {
  assert.equal(formatDate(clampedBillingDate(2026, 1, 31)), '28-02-2026'); // Feb (non-leap)
  assert.equal(formatDate(clampedBillingDate(2026, 3, 31)), '30-04-2026'); // April has 30
  assert.equal(formatDate(clampedBillingDate(2026, 11, 31)), '31-12-2026'); // Dec has 31
});

test('nextBillingForDay always lands strictly after today', () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayDay = today.getDate();
  const next = nextBillingForDay(todayDay); // same day → must roll forward a month
  assert.ok(next > today, 'next billing must be after today');
  // day-of-month preserved (unless clamped by a short month)
  assert.ok(next.getDate() === todayDay || next.getDate() < todayDay);
});

test('renewedOn matches both DD-MM-YYYY HH:MM and ISO timestamps', () => {
  assert.equal(renewedOn({ lastRenewed: '15-06-2026 10:30' }, '15-06-2026'), true);
  assert.equal(renewedOn({ lastRenewed: '2026-06-15T10:30:00.000Z' }, '15-06-2026'), true);
  assert.equal(renewedOn({ lastRenewed: '14-06-2026 23:59' }, '15-06-2026'), false);
  assert.equal(renewedOn({ lastRenewed: '' }, '15-06-2026'), false);
});

test('isPaidJoin excludes silent adds (paidLast 0)', () => {
  assert.equal(isPaidJoin({ joinDate: '15-06-2026', paidLast: 90 }, '15-06-2026'), true);
  assert.equal(isPaidJoin({ joinDate: '15-06-2026', paidLast: 0 }, '15-06-2026'), false);
  assert.equal(isPaidJoin({ joinDate: '14-06-2026', paidLast: 90 }, '15-06-2026'), false);
});

test('pickSurplusReferrals keeps earliest 2, returns rest as surplus', () => {
  const refs = [
    { phone: 'd', joinDate: '20-01-2026' },
    { phone: 'a', joinDate: '02-01-2026' },
    { phone: 'c', joinDate: '15-01-2026' },
    { phone: 'b', joinDate: '08-01-2026' },
  ];
  const { kept, surplus } = pickSurplusReferrals(refs, 2);
  assert.deepEqual(kept.map(r => r.phone), ['a', 'b']);
  assert.deepEqual(surplus.map(r => r.phone), ['c', 'd']);
});

test('rollover: surplus re-pinned via surplusCreditDate counts in next billing window', () => {
  // Referrer's NEW billing date after auto-renew
  const newBilling = '15-07-2026';
  const credit = surplusCreditDate(newBilling); // ~30-06-2026
  const referrer = '9990001111';
  const members = [
    // a surplus referral, re-pinned into the new window
    { phone: '8881112222', reference: referrer, joinDate: '03-06-2026', refCreditDate: credit },
  ];
  const counted = getReferralsInBillingPeriod(referrer, newBilling, members);
  assert.equal(counted.length, 1, 'rolled-over ref should count in the next period');
  // sanity: the credit date sits inside [newBilling-1mo, newBilling)
  const c = parseDate(credit), b = parseDate(newBilling);
  const start = new Date(b); start.setMonth(start.getMonth() - 1);
  assert.ok(c >= start && c < b);
});
