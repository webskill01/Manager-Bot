import { test } from 'node:test';
import assert from 'node:assert';
import { isAppFlow, appCohort, removalDue } from '../core/appFlow.js';
import { formatDate } from '../core/globalConfig.js';

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return formatDate(d); };
const config = { overdue: { finalReminderDays: 6, consolidatedListDays: 7 }, app: { cutover: null } };

test('a member is on the app flow once they paid on the app, or after the cutover date', () => {
  assert.strictEqual(isAppFlow({ appPaidUntil: '' }, config), false);
  assert.strictEqual(isAppFlow({ appPaidUntil: inDays(20) }, config), true);
  const cut = { ...config, app: { cutover: '01-11-2026' } };
  assert.strictEqual(isAppFlow({ appPaidUntil: '' }, cut, '31-10-2026'), false);
  assert.strictEqual(isAppFlow({ appPaidUntil: '' }, cut, '01-11-2026'), true);
});

test('app reminders fire exactly 5 days before, 2 days before and on the day', () => {
  assert.strictEqual(appCohort({ billingDate: inDays(5) }), 'pre5');
  assert.strictEqual(appCohort({ billingDate: inDays(2) }), 'pre2');
  assert.strictEqual(appCohort({ billingDate: inDays(0) }), 'due');
  for (const n of [6, 4, 3, 1, -1, -5]) assert.strictEqual(appCohort({ billingDate: inDays(n) }), null, `day ${n}`);
});

test('app-flow members are removed the day after expiry; old flow waits for the removal list', () => {
  const app = { status: 'ACTIVE', appPaidUntil: inDays(-1), billingDate: inDays(-1) };
  assert.strictEqual(removalDue(app, config), true);
  assert.strictEqual(removalDue({ ...app, billingDate: inDays(0) }, config), false, 'not on the day itself');
  assert.strictEqual(removalDue({ ...app, status: 'REMOVED' }, config), false);
  const old = { status: 'ACTIVE', appPaidUntil: '', billingDate: inDays(-6) };
  assert.strictEqual(removalDue(old, config), false);
  assert.strictEqual(removalDue({ ...old, billingDate: inDays(-7) }, config), true);
});
