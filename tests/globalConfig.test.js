import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampedBillingDate, nextBillingForDay, formatDate, parseDate, daysFromToday,
  renewedOn, isPaidJoin, pickSurplusReferrals, surplusCreditDate,
  getReferralsInBillingPeriod, normalizePhone, normalizeDateCell,
  cronTimePassedToday, beforeCatchUpCutoff,
} from '../core/globalConfig.js';

test('cronTimePassedToday is true only after a daily window has elapsed today', () => {
  const day = (h, m) => new Date(2026, 5, 16, h, m);
  assert.equal(cronTimePassedToday('30 6 * * *', day(9, 0)), true);   // 09:00 is after 06:30
  assert.equal(cronTimePassedToday('30 6 * * *', day(5, 0)), false);  // 05:00 is before 06:30
  assert.equal(cronTimePassedToday('0 10 * * *', day(10, 0)), true);  // exactly 10:00 counts
  assert.equal(cronTimePassedToday('', day(9, 0)), true);             // fail-open on blank
});

test('beforeCatchUpCutoff gates replay to the morning window', () => {
  const at = (h) => new Date(2026, 5, 16, h, 0);
  assert.equal(beforeCatchUpCutoff(12, at(8)), true);    // 08:00 is before noon → replay allowed
  assert.equal(beforeCatchUpCutoff(12, at(11)), true);   // 11:00 still before noon
  assert.equal(beforeCatchUpCutoff(12, at(12)), false);  // noon exactly → no replay
  assert.equal(beforeCatchUpCutoff(12, at(23)), false);  // 23:00 (the bug) → no replay
});

test('normalizePhone strips country code regardless of formatting', () => {
  // The "No member found for 917009686540" bug: a phone stored as a number and read
  // back in scientific notation must NOT silently slice the wrong 10 digits.
  assert.equal(normalizePhone('917009686540'), '7009686540'); // 91 + 10 digits
  assert.equal(normalizePhone(917009686540), '7009686540');   // number-typed cell
  assert.equal(normalizePhone('7009686540'), '7009686540');   // already clean
  assert.equal(normalizePhone('+91 70096 86540'), '7009686540');
  assert.equal(normalizePhone('07009686540'), '7009686540');  // leading 0
  assert.equal(normalizePhone(''), '');
});

test('normalizeDateCell converts Sheets serial numbers back to DD-MM-YYYY', () => {
  const serial = Math.round((new Date(2026, 5, 15) - new Date(1899, 11, 30)) / 86400000);
  assert.equal(normalizeDateCell(serial), '15-06-2026');        // date-only serial
  assert.equal(normalizeDateCell(serial + 0.5), '15-06-2026 12:00'); // datetime serial
  assert.equal(normalizeDateCell('15-06-2026'), '15-06-2026');  // text passthrough
  assert.equal(normalizeDateCell(''), '');
  assert.equal(normalizeDateCell(undefined), '');
});

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

// ── logger timestamp ──────────────────────────────────────────────────────────
// The VPS logged midnight as "24:41:58 IST" on a date that had already rolled over — an
// hour that does not exist. Cause: hour12:false lets the locale pick the hour cycle, and
// the VPS's ICU resolved en-IN to h24 (1-24) while the dev machine gave h23 (0-23). Same
// code, different output, which is why it survived review. hourCycle pins it.
test('IST timestamps use a 0-23 hour cycle, never 24', () => {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const hourOf = (iso) =>
    fmt.formatToParts(new Date(iso)).find(p => p.type === 'hour').value;

  assert.equal(hourOf('2026-08-18T19:11:58Z'), '00', 'midnight IST must be 00, not 24');
  assert.equal(hourOf('2026-08-18T18:30:00Z'), '00');
  assert.equal(hourOf('2026-08-18T19:30:00Z'), '01');
  assert.equal(hourOf('2026-08-18T06:30:00Z'), '12');
  assert.equal(hourOf('2026-08-18T18:29:00Z'), '23');
});

test('core/logger.js pins hourCycle rather than relying on hour12', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('core/logger.js', 'utf8');
  assert.match(src, /hourCycle: 'h23'/, 'the hour cycle must be explicit');
  // Strip // comments first — the fix carries an explanation that names hour12:false, and
  // matching against prose would fail on the very comment describing the bug.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/hour12:\s*false/.test(code),
    'hour12:false lets the locale choose h23 or h24 — that is the bug');
});
