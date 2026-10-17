import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { buildDmList } from '../core/dmList.js';
import { buildDripBatch, COHORTS, describeQueue, countByCohort } from '../core/dripEngine.js';
import { formatDate } from '../core/globalConfig.js';

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return formatDate(d); };
const config = {
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  renewal: { fullAmount: 90 },
  app: { price: 149 },
  messages: {
    reminder: ['QR {name}'], overdue: ['OVER {name}'], finalReminder: ['FINAL {name}'],
    appReminder: { pre5: ['P5 app groups {name} {date}'], pre2: ['P2 app groups {name}'], due: ['D app groups {name}'] },
  },
};
const app = (phone, d) => ({ name: `A${phone}`, phone, status: 'ACTIVE', billingDate: inDays(d), appPaidUntil: inDays(d) });
const old = (phone, d) => ({ name: `Q${phone}`, phone, status: 'ACTIVE', billingDate: inDays(d), appPaidUntil: '' });

test('app-flow members get pre5 / pre2 / due-day wording from messages.appReminder', () => {
  const members = [app('9000000001', 5), app('9000000002', 2), app('9000000003', 0), app('9000000004', 3)];
  const rows = (cohort) => buildDmList({ members, config, cohort }).rows;
  assert.deepStrictEqual(rows('pre5').map(r => [r.phone, r.stage, r.daysLeft, r.fee]), [['9000000001', 'app_pre5', 5, 149]]);
  assert.match(rows('pre5')[0].text, /^P5 app groups A9000000001 /);
  assert.deepStrictEqual(rows('pre2').map(r => r.stage), ['app_pre2']);
  assert.deepStrictEqual(rows('due').map(r => [r.phone, r.stage]), [['9000000003', 'app_due']]);
});

test('app-flow members are never chased after expiry; old-flow members are never chased early', () => {
  const members = [app('9000000001', -5), app('9000000002', -1), old('9000000003', 5), old('9000000004', 2), old('9000000005', -5)];
  for (const cohort of ['missed', 'nudge', 'final']) {
    assert.ok(buildDmList({ members, config, cohort }).rows.every(r => r.phone >= '9000000003'), cohort);
  }
  assert.deepStrictEqual(buildDmList({ members, config, cohort: 'pre5' }).rows, []);
  assert.deepStrictEqual(buildDmList({ members, config, cohort: 'pre2' }).rows, []);
  assert.deepStrictEqual(buildDmList({ members, config, cohort: 'nudge' }).rows.map(r => r.phone), ['9000000005']);
});

test('old flow is untouched during the transition: day-0 QR reminder still goes out', () => {
  const rows = buildDmList({ members: [old('9000000001', 0)], config, cohort: 'due' }).rows;
  assert.deepStrictEqual(rows.map(r => [r.stage, r.fee, r.text]), [['msg1', 90, 'QR Q9000000001']]);
});

test('after the cutover date everyone is on the app flow', () => {
  const cut = { ...config, app: { ...config.app, cutover: inDays(-1) } };
  const rows = buildDmList({ members: [old('9000000001', 5)], config: cut, cohort: 'pre5' }).rows;
  assert.deepStrictEqual(rows.map(r => r.stage), ['app_pre5']);
});

test('drip order: due, pre2, nudge, final, pre5, missed', () => {
  assert.deepStrictEqual(COHORTS, ['due', 'pre2', 'nudge', 'final', 'pre5', 'missed']);
  const members = [app('9000000001', 5), old('9000000002', -5), app('9000000003', 2), old('9000000004', 0)];
  const batch = buildDripBatch({ members, config, max: 4 });
  assert.deepStrictEqual(batch.map(r => r.stage), ['msg1', 'app_pre2', 'msg2', 'app_pre5']);
  const split = countByCohort({ members, config });
  assert.strictEqual(describeQueue(split), '4 (1 due, 1 app 2d, 1 nudge, 1 app 5d)');
});

test('the drip never attaches the UPI QR to an app-flow reminder', () => {
  const src = fs.readFileSync(new URL('../core/dripEngine.js', import.meta.url), 'utf8');
  assert.match(src, /function needsQr[^{]*\{[\s\S]{0,300}startsWith\('app_'\)\) return false;/);
});

test('every shipped bot: app block, varied pitch, app reminders that name the app AND the groups', () => {
  const BOTS = ['bot-nitin', 'bot-abhi', 'bot-sachin2', 'bot-aayush2'];
  const seen = new Map();
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(new URL(`../bots/${bot}/config.json`, import.meta.url), 'utf8'));
    assert.match(cfg.app.playStoreUrl, /^https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.easecab\.app$/);
    assert.ok(new Set(cfg.messages.appPitch).size >= 8, `${bot}: needs varied appPitch`);
    for (const [stage, d] of [['pre5', 5], ['pre2', 2], ['due', 0]]) {
      const list = cfg.messages.appReminder[stage];
      assert.ok(list.length >= 3, `${bot}/${stage}: too few variants`);
      for (const t of list) {
        assert.match(t, /\bapp\b/i, `${bot}/${stage}: no "app" in ${t}`);
        assert.match(t, /group/i, `${bot}/${stage}: no "groups" in ${t}`);
        assert.ok(!seen.has(t), `${bot}/${stage} repeats ${seen.get(t)}'s wording`);
        seen.set(t, bot);
      }
      const members = Array.from({ length: 12 }, (_, i) => app(`90000000${String(i).padStart(2, '0')}`, d));
      for (const r of buildDmList({ members, config: cfg, cohort: stage }).rows) {
        assert.ok(!/\{name\}|\{date\}/.test(r.text), `${bot}/${stage}: unsubstituted ${r.text}`);
      }
    }
  }
});
