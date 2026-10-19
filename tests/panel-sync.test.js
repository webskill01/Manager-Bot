import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPayments } from '../panel/lib/sync.js';
import { buildPeople } from '../panel/lib/people.js';
import { formatDate } from '../core/globalConfig.js';

const day = (n) => formatDate(new Date(Date.now() + n * 86400e3));
const botCfg = { 'bot-abhi': { botName: 'bot-abhi', renewal: { fullAmount: 100, referralAmount: 100 }, removalDay: 7 } };

test('detectPayments: moved to app beats a group renewal; one payment per change', () => {
  const mk = (billingDate, expiresAt) => buildPeople({
    sheets: { 'bot-abhi': [{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate, paidLast: 100 }] },
    app: expiresAt ? [{ phone: '9000000001', status: 'active', expiresAt, paidCount: 1, lastAmount: 149 }] : [],
  });
  const before = mk(day(-2));
  assert.deepEqual(detectPayments(before, mk(day(-2)), botCfg), []);
  const [p] = detectPayments(before, mk(day(28)), botCfg);
  assert.deepEqual({ ...p, at: undefined }, { phone: '9000000001', bot: 'bot-abhi', amount: 100, billingFrom: day(-2), source: 'sheet', at: undefined });
  const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
  const both = detectPayments(before, mk(day(28), exp), botCfg);
  assert.equal(both.length, 1, 'sheet and app moving together is still one payment');
  assert.equal(both[0].source, 'app');
  assert.equal(both[0].amount, 149);
  assert.equal(detectPayments(mk(day(-2), exp), mk(day(-2), exp), botCfg).length, 0, 'already on the app: nothing new');
  assert.equal(detectPayments(new Map(), mk(day(28)), botCfg).length, 0, 'first sync records nothing');
});
