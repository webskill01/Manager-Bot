import { test } from 'node:test';
import assert from 'node:assert';
import { pickStage, buildDmList, chunkByChars, renderDmList } from '../core/dmList.js';
import { todayStr } from '../core/globalConfig.js';

const cfg = {
  joining: { fee: 90 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6 },
  messages: {
    reminder: 'DUE {name} {date}',
    referralReminder: 'REF {name}',
    overdue: 'LATE {name}',
    finalReminder: 'FINAL {name}',
  },
};

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

test('pickStage buckets by overdue days when nothing is forced', () => {
  assert.equal(pickStage(0, cfg), 'msg1');
  assert.equal(pickStage(4, cfg), 'msg1');
  assert.equal(pickStage(5, cfg), 'msg2');
  assert.equal(pickStage(6, cfg), 'msg3');
  assert.equal(pickStage(30, cfg), 'msg3');
});

test('window is backwards-only — nobody due in the future appears', () => {
  const members = [
    { name: 'Today', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() },
    { name: 'Future', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(-3) },
  ];
  const { rows } = buildDmList({ members, config: cfg, days: 7 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '9000000001');
});

test('days window includes backlog and excludes anyone older than it', () => {
  const members = [
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6) },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(9) },
  ];
  assert.equal(buildDmList({ members, config: cfg, days: 7 }).rows.length, 1);
  assert.equal(buildDmList({ members, config: cfg, days: 10 }).rows.length, 2);
});

test('default days=0 is today only', () => {
  const members = [
    { name: 'Today', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() },
    { name: 'Yesterday', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(1) },
  ];
  const { rows } = buildDmList({ members, config: cfg });
  assert.deepEqual(rows.map(r => r.phone), ['9000000001']);
});

test('auto stage gives a 6-day-overdue member the final wording', () => {
  const members = [{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6) }];
  const { rows } = buildDmList({ members, config: cfg, days: 7 });
  assert.equal(rows[0].stage, 'msg3');
  assert.match(rows[0].text, /^FINAL /);
});

test('forced msg1 overrides the bucket for everyone', () => {
  const members = [
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6) },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: todayStr() },
  ];
  const { rows, stageForced } = buildDmList({ members, config: cfg, days: 7, force: 'msg1' });
  assert.equal(stageForced, true);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.text.startsWith('DUE ')), 'all got msg1 wording');
});

test('link is a wa.me url with 91 prefix and url-encoded text', () => {
  const members = [{ name: 'A B', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() }];
  const { rows } = buildDmList({ members, config: cfg, days: 0 });
  assert.match(rows[0].link, /^https:\/\/wa\.me\/919000000001\?text=/);
  assert.ok(!rows[0].link.includes(' '), 'no raw spaces in the url');
  assert.match(decodeURIComponent(rows[0].link.split('?text=')[1]), /^DUE A B /);
});

test('newlines in a template survive url encoding intact', () => {
  const multiline = { ...cfg, messages: { ...cfg.messages, reminder: 'Hello {name}\nLine two\nLine three' } };
  const members = [{ name: 'X', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() }];
  const { rows } = buildDmList({ members, config: multiline, days: 0 });
  assert.ok(!rows[0].link.includes('\n'), 'raw newline would break the link');
  assert.equal(decodeURIComponent(rows[0].link.split('?text=')[1]), 'Hello X\nLine two\nLine three');
});

test('delayed, non-active and renewed-today members are excluded', () => {
  const members = [
    { name: 'Delayed', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr(), delayUntil: daysAgo(-5) },
    { name: 'Removed', phone: '9000000002', status: 'REMOVED', billingDate: todayStr() },
    { name: 'Paid', phone: '9000000003', status: 'ACTIVE', billingDate: todayStr(), lastRenewed: todayStr() },
    { name: 'Real', phone: '9000000004', status: 'ACTIVE', billingDate: todayStr() },
  ];
  const { rows } = buildDmList({ members, config: cfg, days: 0 });
  assert.deepEqual(rows.map(r => r.phone), ['9000000004']);
});

// refCreditDate must be strictly BEFORE the billing date — the referral window is
// half-open, [billingDate - 1 month, billingDate).
test('one referral in the window gets the referral wording and half fee', () => {
  const members = [
    { name: 'Boss', phone: '9000000009', status: 'ACTIVE', billingDate: todayStr() },
    { name: 'Ref1', phone: '9000000001', status: 'ACTIVE', reference: '9000000009', refCreditDate: daysAgo(5) },
  ];
  const { rows } = buildDmList({ members, config: cfg, days: 0 });
  const boss = rows.find(r => r.phone === '9000000009');
  assert.match(boss.text, /^REF /);
  assert.equal(boss.fee, 45);
});

test('no referral means full fee and the plain reminder', () => {
  const members = [{ name: 'Solo', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() }];
  const { rows } = buildDmList({ members, config: cfg, days: 0 });
  assert.equal(rows[0].fee, 90);
  assert.match(rows[0].text, /^DUE /);
});

test('rows are sorted most-overdue first', () => {
  const members = [
    { name: 'New', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() },
    { name: 'Old', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(5) },
    { name: 'Mid', phone: '9000000003', status: 'ACTIVE', billingDate: daysAgo(2) },
  ];
  const { rows } = buildDmList({ members, config: cfg, days: 7 });
  assert.deepEqual(rows.map(r => r.name), ['Old', 'Mid', 'New']);
});

test('chunkByChars never emits a chunk over the limit and preserves order', () => {
  const lines = Array.from({ length: 40 }, (_, i) => 'x'.repeat(200) + i);
  const chunks = chunkByChars(lines, 1000);
  assert.ok(chunks.every(c => c.join('\n').length <= 1000));
  assert.deepEqual(chunks.flat(), lines, 'nothing dropped or reordered');
});

test('chunkByChars keeps an over-long line rather than dropping it', () => {
  const chunks = chunkByChars(['short', 'y'.repeat(5000), 'also short'], 1000);
  assert.deepEqual(chunks.flat(), ['short', 'y'.repeat(5000), 'also short']);
});

test('renderDmList says nobody when the list is empty', () => {
  const parts = renderDmList({ rows: [], days: 7, stageForced: false });
  assert.equal(parts.length, 1);
  assert.match(parts[0], /Nobody to remind in the last 7 day/);
});

test('renderDmList splits a big list into numbered parts, all under the cap', () => {
  const members = Array.from({ length: 60 }, (_, i) => ({
    name: `Member Number ${i}`,
    phone: `90000${String(i).padStart(5, '0')}`,
    status: 'ACTIVE',
    billingDate: todayStr(),
  }));
  const { rows, stageForced } = buildDmList({ members, config: cfg, days: 0 });
  const parts = renderDmList({ rows, days: 0, stageForced });
  assert.ok(parts.length > 1, 'must split');
  assert.ok(parts.every(p => p.length <= 4096), 'every part fits one WhatsApp message');
  // Every member must appear exactly once across the parts.
  const joined = parts.join('\n');
  for (const m of members) assert.ok(joined.includes(m.phone), `${m.phone} missing`);
});
