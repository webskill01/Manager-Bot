import { test } from 'node:test';
import assert from 'node:assert';
import { pickStage, buildDmList, chunkByChars, renderDmList } from '../core/dmList.js';
import { todayStr, friendlyDate } from '../core/globalConfig.js';

const cfg = {
  joining: { fee: 90 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
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

// Day-of-month of a date N days back — lets the date-mode tests pick a billingDay that is
// guaranteed to be in the past regardless of what today happens to be.
function dayOfMonthAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getDate();
}

const member = (phone, billingDate, extra = {}) =>
  ({ name: `M${phone.slice(-1)}`, phone, status: 'ACTIVE', billingDate, ...extra });

test('pickStage buckets by overdue days when nothing is forced', () => {
  assert.equal(pickStage(0, cfg), 'msg1');
  assert.equal(pickStage(4, cfg), 'msg1');
  assert.equal(pickStage(5, cfg), 'msg2');
  assert.equal(pickStage(6, cfg), 'msg3');
  assert.equal(pickStage(30, cfg), 'msg3');
});

// ── Cohorts: one command per wording ──────────────────────────────────────────

// The three cohorts must not overlap and must not leak. If 'due' widened by even a day,
// people would get the same first message twice.
test('each cohort selects only its own slice', () => {
  const members = [
    member('9000000000', todayStr()),   // 0d
    member('9000000002', daysAgo(2)),   // 2d — nobody's cohort
    member('9000000005', daysAgo(5)),   // 5d
    member('9000000006', daysAgo(6)),   // 6d
    member('9000000030', daysAgo(30)),  // 30d
  ];
  const phones = c => buildDmList({ members, config: cfg, cohort: c }).rows.map(r => r.phone);

  assert.deepEqual(phones('due'), ['9000000000']);
  assert.deepEqual(phones('nudge'), ['9000000005']);
  assert.deepEqual(phones('final'), ['9000000006'], 'final is day 6 only');
});

// The bug this replaces: 'final' was `overdueDays >= final`, so day 7, day 8 and day 30 kept
// matching and the drip re-sent the FINAL notice every single morning, forever. At
// consolidatedListDays the ladder ends — they belong to `overdue` and `kickall` from then on.
test('nobody past the removal threshold is messaged again', () => {
  const members = [
    member('9000000006', daysAgo(6)),
    member('9000000007', daysAgo(7)),
    member('9000000008', daysAgo(8)),
    member('9000000030', daysAgo(30)),
  ];
  for (const cohort of ['due', 'nudge', 'final']) {
    const phones = buildDmList({ members, config: cfg, cohort }).rows.map(r => r.phone);
    for (const stale of ['9000000007', '9000000008', '9000000030']) {
      assert.ok(!phones.includes(stale), `${cohort} still chases a ${stale.slice(-2)}d member`);
    }
  }
});

// A bot that pushes finalReminderDays out must not grow silent days or a repeating notice:
// the ceiling follows the config, and defaults to "the day after the final notice".
test('the final cohort ceiling follows consolidatedListDays, and defaults to final + 1', () => {
  const members = [6, 7, 8, 9].map(n => member(`900000000${n}`, daysAgo(n)));
  const wide = { ...cfg, overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 9 } };
  assert.deepEqual(
    buildDmList({ members, config: wide, cohort: 'final' }).rows.map(r => r.overdueDays),
    [8, 7, 6],
  );
  const noThreshold = { ...cfg, overdue: { autoReminderDays: 5, finalReminderDays: 6 } };
  assert.deepEqual(
    buildDmList({ members, config: noThreshold, cohort: 'final' }).rows.map(r => r.overdueDays),
    [6],
  );
});

test('each cohort lands on its own wording with no force', () => {
  const members = [
    member('9000000000', todayStr()),
    member('9000000005', daysAgo(5)),
    member('9000000006', daysAgo(6)),
  ];
  const stageOf = c => buildDmList({ members, config: cfg, cohort: c }).rows[0].stage;
  assert.equal(stageOf('due'), 'msg1');
  assert.equal(stageOf('nudge'), 'msg2');
  assert.equal(stageOf('final'), 'msg3');
  assert.match(buildDmList({ members, config: cfg, cohort: 'final' }).rows[0].text, /^FINAL /);
});

test('cohort boundaries come from config, not hardcoded 5 and 6', () => {
  const fast = { ...cfg, overdue: { autoReminderDays: 3, finalReminderDays: 4, consolidatedListDays: 6 } };
  const members = [
    member('9000000003', daysAgo(3)),
    member('9000000004', daysAgo(4)),
    member('9000000005', daysAgo(5)),
    member('9000000006', daysAgo(6)),
  ];
  assert.deepEqual(
    buildDmList({ members, config: fast, cohort: 'nudge' }).rows.map(r => r.phone),
    ['9000000003'],
  );
  assert.deepEqual(
    buildDmList({ members, config: fast, cohort: 'final' }).rows.map(r => r.phone).sort(),
    ['9000000004', '9000000005'],
  );
});

test('nobody due in the future appears, in any cohort', () => {
  const members = [
    member('9000000001', todayStr()),
    member('9000000002', daysAgo(-3)),
  ];
  for (const cohort of ['due', 'nudge', 'final']) {
    const { rows } = buildDmList({ members, config: cfg, cohort });
    assert.ok(!rows.some(r => r.phone === '9000000002'), `${cohort} chased a future date`);
  }
});

// ── Date mode: dmlist 27 ──────────────────────────────────────────────────────

test('date mode matches a day of the month across different months', () => {
  const day = dayOfMonthAgo(40);
  const twoMonthsBack = new Date();
  twoMonthsBack.setDate(twoMonthsBack.getDate() - 40);
  twoMonthsBack.setMonth(twoMonthsBack.getMonth() - 1);
  const older = `${String(twoMonthsBack.getDate()).padStart(2, '0')}-${String(twoMonthsBack.getMonth() + 1).padStart(2, '0')}-${twoMonthsBack.getFullYear()}`;

  const members = [
    member('9000000001', daysAgo(40)),   // day-of-month = day
    member('9000000002', older),         // same day-of-month, a month earlier
    member('9000000003', daysAgo(41)),   // neighbouring day — must not match
  ];
  const { rows } = buildDmList({ members, config: cfg, billingDay: day });
  assert.deepEqual(rows.map(r => r.phone).sort(), ['9000000001', '9000000002']);
});

test('date mode still refuses to chase a future billing date', () => {
  const future = new Date();
  future.setDate(future.getDate() + 10);
  const day = future.getDate();
  const members = [member('9000000001', `${String(day).padStart(2, '0')}-${String(future.getMonth() + 1).padStart(2, '0')}-${future.getFullYear()}`)];
  assert.equal(buildDmList({ members, config: cfg, billingDay: day }).rows.length, 0);
});

// The whole point of defaulting a date batch to msg1: auto-escalation would hand a
// 25-day-overdue member the final notice as the first message of the round.
test('a forced msg1 gives a 25-day-overdue member the plain reminder', () => {
  const members = [member('9000000001', daysAgo(25))];
  const { rows, stageForced } = buildDmList({
    members, config: cfg, billingDay: dayOfMonthAgo(25), force: 'msg1',
  });
  assert.equal(stageForced, true);
  assert.equal(rows[0].stage, 'msg1');
  assert.match(rows[0].text, /^DUE /);
});

test('date mode carries the billingDay back out for the renderer', () => {
  const out = buildDmList({ members: [], config: cfg, billingDay: 27 });
  assert.equal(out.billingDay, 27);
  assert.equal(buildDmList({ members: [], config: cfg, cohort: 'final' }).cohort, 'final');
});

// ── Row contents (unchanged behaviour) ────────────────────────────────────────

test('link is a wa.me url with 91 prefix and url-encoded text', () => {
  const members = [{ name: 'A B', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() }];
  const { rows } = buildDmList({ members, config: cfg });
  assert.match(rows[0].link, /^https:\/\/wa\.me\/919000000001\?text=/);
  assert.ok(!rows[0].link.includes(' '), 'no raw spaces in the url');
  assert.match(decodeURIComponent(rows[0].link.split('?text=')[1]), /^DUE A B /);
});

test('newlines in a template survive url encoding intact', () => {
  const multiline = { ...cfg, messages: { ...cfg.messages, reminder: 'Hello {name}\nLine two\nLine three' } };
  const members = [member('9000000001', todayStr())];
  const { rows } = buildDmList({ members, config: multiline });
  assert.ok(!rows[0].link.includes('\n'), 'raw newline would break the link');
  assert.equal(decodeURIComponent(rows[0].link.split('?text=')[1]), 'Hello M1\nLine two\nLine three');
});

test('delayed, non-active and renewed-today members are excluded', () => {
  const members = [
    { name: 'Delayed', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr(), delayUntil: daysAgo(-5) },
    { name: 'Removed', phone: '9000000002', status: 'REMOVED', billingDate: todayStr() },
    { name: 'Paid', phone: '9000000003', status: 'ACTIVE', billingDate: todayStr(), lastRenewed: todayStr() },
    { name: 'Real', phone: '9000000004', status: 'ACTIVE', billingDate: todayStr() },
  ];
  const { rows } = buildDmList({ members, config: cfg });
  assert.deepEqual(rows.map(r => r.phone), ['9000000004']);
});

// refCreditDate must be strictly BEFORE the billing date — the referral window is
// half-open, [billingDate - 1 month, billingDate).
test('one referral in the window gets the referral wording and half fee', () => {
  const members = [
    { name: 'Boss', phone: '9000000009', status: 'ACTIVE', billingDate: todayStr() },
    { name: 'Ref1', phone: '9000000001', status: 'ACTIVE', reference: '9000000009', refCreditDate: daysAgo(5) },
  ];
  const { rows } = buildDmList({ members, config: cfg });
  const boss = rows.find(r => r.phone === '9000000009');
  assert.match(boss.text, /^REF /);
  assert.equal(boss.fee, 45);
});

test('no referral means full fee and the plain reminder', () => {
  const members = [{ name: 'Solo', phone: '9000000001', status: 'ACTIVE', billingDate: todayStr() }];
  const { rows } = buildDmList({ members, config: cfg });
  assert.equal(rows[0].fee, 90);
  assert.match(rows[0].text, /^DUE /);
});

// {date} used to render today for everyone. On a backlog run that is just wrong — someone
// billed on the 20th was being told their date was the 28th.
test('{date} renders each member\'s own billing date, never today', () => {
  const members = [
    member('9000000001', daysAgo(20)),
    member('9000000002', daysAgo(8)),
    member('9000000003', todayStr()),
  ];
  // billingDay is left null and the cohort filter widened for this one: the subject is
  // {date} rendering, and the 6-day ceiling would otherwise drop the backdated members the
  // test exists to check.
  const wide = { ...cfg, overdue: { ...cfg.overdue, consolidatedListDays: 999 } };
  const { rows } = buildDmList({ members, config: wide, cohort: 'final', force: 'msg1' });
  assert.equal(rows.length, 2, 'the two backdated members are the subject here');
  for (const r of rows) {
    const billed = members.find(m => m.phone === r.phone).billingDate;
    assert.equal(r.text, `DUE ${r.name} ${friendlyDate(billed)}`, `${r.phone} got the wrong date`);
    assert.equal(decodeURIComponent(r.link.split('?text=')[1]), r.text, 'link text matches');
  }
  // Guard against the two backdated members coincidentally rendering today's date.
  assert.ok(!rows.some(r => r.text.endsWith(friendlyDate())), 'nobody overdue shows today');
});

test('rows are sorted most-overdue first', () => {
  const members = [
    member('9000000006', daysAgo(6)),
    member('9000000030', daysAgo(30)),
    member('9000000009', daysAgo(9)),
  ];
  const wide = { ...cfg, overdue: { ...cfg.overdue, consolidatedListDays: 999 } };
  const { rows } = buildDmList({ members, config: wide, cohort: 'final' });
  assert.deepEqual(rows.map(r => r.overdueDays), [30, 9, 6]);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

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

test('each mode has its own header label', () => {
  const rows = [{ name: 'A', phone: '9000000001', overdueDays: 0, stage: 'msg1', fee: 90, text: 't', link: 'https://wa.me/1' }];
  const head = o => renderDmList({ rows, stageForced: false, config: cfg, ...o })[0];
  assert.match(head({ cohort: 'due' }), /· due today/);
  assert.match(head({ cohort: 'nudge' }), /· 5 days overdue/);
  assert.match(head({ cohort: 'final' }), /· 6 days overdue/);
  assert.match(head({ billingDay: 27 }), /· billed on the 27th/);
  assert.match(head({ billingDay: 1 }), /· billed on the 1st/);
});

test('each mode says who is missing when the list is empty', () => {
  const empty = o => renderDmList({ rows: [], stageForced: false, config: cfg, ...o })[0];
  assert.match(empty({ cohort: 'due' }), /Nobody is due today/);
  assert.match(empty({ cohort: 'nudge' }), /Nobody is 5 days overdue/);
  assert.match(empty({ cohort: 'final' }), /Nobody is 6 days overdue/);
  assert.match(empty({ billingDay: 27 }), /Nobody billed on the 27th is due right now/);
});

test('empty-state day counts follow config too', () => {
  const fast = { ...cfg, overdue: { autoReminderDays: 3, finalReminderDays: 4, consolidatedListDays: 6 } };
  assert.match(renderDmList({ rows: [], stageForced: false, cohort: 'nudge', config: fast })[0], /3 days overdue/);
  assert.match(renderDmList({ rows: [], stageForced: false, cohort: 'final', config: fast })[0], /4-5 days overdue/);
});

test('renderDmList splits a big list into numbered parts, all under the cap', () => {
  const day = dayOfMonthAgo(20);
  const members = Array.from({ length: 60 }, (_, i) => ({
    name: `Member Number ${i}`,
    phone: `90000${String(i).padStart(5, '0')}`,
    status: 'ACTIVE',
    billingDate: daysAgo(20),
  }));
  const { rows, stageForced, billingDay } = buildDmList({ members, config: cfg, billingDay: day, force: 'msg1' });
  assert.equal(rows.length, 60, 'the whole date batch is present');
  const parts = renderDmList({ rows, stageForced, billingDay, config: cfg });
  assert.ok(parts.length > 1, 'must split');
  assert.ok(parts.every(p => p.length <= 4096), 'every part fits one WhatsApp message');
  // Every member must appear exactly once across the parts.
  const joined = parts.join('\n');
  for (const m of members) assert.ok(joined.includes(m.phone), `${m.phone} missing`);
});
