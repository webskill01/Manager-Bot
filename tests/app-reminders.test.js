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
    appReminder: { due: ['D app groups {name} {date} {fee}'], after: ['AF app groups {name}'] },
  },
};
const app = (phone, d) => ({ name: `A${phone}`, phone, status: 'ACTIVE', billingDate: inDays(d), appPaidUntil: inDays(d) });
const old = (phone, d) => ({ name: `Q${phone}`, phone, status: 'ACTIVE', billingDate: inDays(d), appPaidUntil: '' });

test('app-flow members get due-day and day-after wording from messages.appReminder', () => {
  const members = [app('9000000001', 5), app('9000000002', -1), app('9000000003', 0), app('9000000004', -2)];
  const rows = (cohort) => buildDmList({ members, config, cohort }).rows;
  assert.deepStrictEqual(rows('due').map(r => [r.phone, r.stage, r.fee]), [['9000000003', 'app_due', 149]]);
  assert.match(rows('due')[0].text, /^D app groups A9000000003 .* 149$/);
  assert.deepStrictEqual(rows('after').map(r => [r.phone, r.stage, r.overdueDays]), [['9000000002', 'app_after', 1]]);
});

test('app-flow members never get the group ladder; old-flow members never get "after"', () => {
  const members = [app('9000000001', -5), app('9000000002', -1), old('9000000003', 5), old('9000000004', -1), old('9000000005', -5)];
  for (const cohort of ['missed', 'nudge', 'final']) {
    assert.ok(buildDmList({ members, config, cohort }).rows.every(r => r.phone >= '9000000003'), cohort);
  }
  assert.deepStrictEqual(buildDmList({ members, config, cohort: 'after' }).rows.map(r => r.phone), ['9000000002']);
  assert.deepStrictEqual(buildDmList({ members, config, cohort: 'nudge' }).rows.map(r => r.phone), ['9000000005']);
});

test('old flow: day-0 QR reminder, {fee} from renewal.fullAmount', () => {
  const cfg = { ...config, messages: { ...config.messages, reminder: ['QR {name} {fee}'] } };
  const rows = buildDmList({ members: [old('9000000001', 0)], config: cfg, cohort: 'due' }).rows;
  assert.deepStrictEqual(rows.map(r => [r.stage, r.fee, r.text]), [['msg1', 90, 'QR Q9000000001 90']]);
});

test('renewal.referrals:false: 1-ref member pays full price; groupTrack:false: old flow gets nothing', () => {
  const ref = { ...old('9000000002', 0), reference: '9000000001', joinDate: inDays(-3), status: 'ACTIVE' };
  const members = [old('9000000001', 0), ref];
  const cfg = { ...config, renewal: { fullAmount: 149, referralAmount: 45, referrals: false } };
  const on = { ...cfg, renewal: { ...cfg.renewal, referrals: true } };
  assert.deepStrictEqual(buildDmList({ members, config: on, cohort: 'due' }).rows.map(r => r.fee).sort(), [149, 45].sort());
  assert.deepStrictEqual(buildDmList({ members, config: cfg, cohort: 'due' }).rows.map(r => r.fee), [149, 149]);
  assert.deepStrictEqual(buildDmList({ members, config: { ...cfg, groupTrack: false }, cohort: 'due' }).rows, []);
});

test('after the cutover date everyone is on the app flow', () => {
  const cut = { ...config, app: { ...config.app, cutover: inDays(-1) } };
  const rows = buildDmList({ members: [old('9000000001', 0)], config: cut, cohort: 'due' }).rows;
  assert.deepStrictEqual(rows.map(r => r.stage), ['app_due']);
});

test('drip order: due, after, nudge, final, catchup, fresh, missed', () => {
  assert.deepStrictEqual(COHORTS, ['due', 'after', 'nudge', 'final', 'catchup', 'fresh', 'missed']);
  const members = [app('9000000001', -1), old('9000000002', -5), app('9000000003', 0), old('9000000004', -2)];
  const batch = buildDripBatch({ members, config, max: 4 });
  assert.deepStrictEqual(batch.map(r => r.stage), ['app_due', 'app_after', 'msg2', 'msg1']);
  const split = countByCohort({ members, config });
  assert.strictEqual(describeQueue(split), '4 (1 due, 1 app ended, 1 nudge, 1 missed)');
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
    for (const [stage, d] of [['due', 0], ['after', -1]]) {
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
        assert.ok(!/{name}|{date}|{fee}/.test(r.text), `${bot}/${stage}: unsubstituted ${r.text}`);
      }
    }
  }
});
