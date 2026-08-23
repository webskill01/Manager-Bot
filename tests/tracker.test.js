import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCallDue, needsFollowUp, isTracker, formatDate } from '../core/globalConfig.js';
import { createTrackerHandlers } from '../core/handlers/trackerHandlers.js';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { createCommandParser } from '../core/commandParser.js';
import { createScheduler } from '../core/scheduler.js';

const log = { info() {}, warn() {}, error() {} };

function dayOffset(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function fakeStore(members) {
  const rows = members.map(m => ({ ...m }));
  const writes = [];
  return {
    writes,
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    async refresh() {},
    async update(phone, updates) {
      const row = rows.find(m => m.phone === phone);
      if (!row) throw new Error(`Member not found: ${phone}`);
      Object.assign(row, updates);
      writes.push({ phone, updates });
      return { ...row };
    },
  };
}

const trackerConfig = (botDir, extra = {}) => ({
  botDir,
  botName: 'bot-test',
  profile: 'tracker',
  paidGroups: ['g1@g.us', 'g2@g.us'],
  joining: { fee: 100 },
  renewal: { fullAmount: 100, referralAmount: 100 },
  overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  split: { shares: [{ label: 'A', percent: 60 }, { label: 'B', percent: 20 }, { label: 'C', percent: 20 }] },
  ...extra,
});

function fakeGroupManager(result = { removed: ['g1@g.us', 'g2@g.us'], failed: [] }) {
  const calls = [];
  return {
    calls,
    async removeFromAllGroups(phone) { calls.push(phone); return result; },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trk-'));

// ── derived lifecycle ────────────────────────────────────────────────────────

test('isCallDue: exactly at the boundary counts, a day short does not', () => {
  const at30 = { status: 'NEW', joinDate: dayOffset(-30) };
  const at29 = { status: 'NEW', joinDate: dayOffset(-29) };
  const at31 = { status: 'NEW', joinDate: dayOffset(-31) };
  assert.equal(isCallDue(at30, 30), true, '30 days is due');
  assert.equal(isCallDue(at29, 30), false, '29 days is not');
  assert.equal(isCallDue(at31, 30), true);
});

test('isCallDue: anyone already called or gone is out of the queue', () => {
  for (const status of ['CALLED', 'REMOVED', 'SKIPPED']) {
    assert.equal(isCallDue({ status, joinDate: dayOffset(-60) }, 30), false, `${status} not due`);
  }
});

// Rows predating the tracker profile (migrated members, or anyone added while the bot ran
// the full renewal profile) carry ACTIVE, not NEW. They are still uncalled people sitting
// in the group — if ACTIVE were excluded, an operator's whole existing list would be
// invisible to `pending` with nothing to hint at why.
test('isCallDue: ACTIVE counts as uncalled, so pre-tracker rows still surface', () => {
  assert.equal(isCallDue({ status: 'ACTIVE', joinDate: dayOffset(-60) }, 30), true);
  assert.equal(isCallDue({ status: 'ACTIVE', joinDate: dayOffset(-10) }, 30), false, 'still respects the window');
});

test('isCallDue: a configurable window is respected, junk dates are safe', () => {
  assert.equal(isCallDue({ status: 'NEW', joinDate: dayOffset(-10) }, 7), true);
  assert.equal(isCallDue({ status: 'NEW', joinDate: '' }, 30), false);
  assert.equal(isCallDue(null, 30), false);
});

test('needsFollowUp: only an UNANSWERED call resurfaces after the chase window', () => {
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-3) }, 3), true);
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-2) }, 3), false, 'too soon');
  assert.equal(needsFollowUp({ status: 'NEW', callDate: '' }, 3), false);
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: '' }, 3), true, 'called but undated is always worth chasing');
  // Once an answer is logged the pitch is resolved — it never comes back either way.
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-30), callResult: 'interested' }, 3), false);
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-30), callResult: 'not-interested' }, 3), false);
});

test('isTracker only matches the tracker profile', () => {
  assert.equal(isTracker({ profile: 'tracker' }), true);
  assert.equal(isTracker({ profile: 'full' }), false);
  assert.equal(isTracker({}), false);
  assert.equal(isTracker(null), false);
});

// ── pending / called / log ───────────────────────────────────────────────────

test('pending splits the month-up list from the no-answer list, oldest first', async () => {
  const store = fakeStore([
    { name: 'Old', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-45) },
    { name: 'Due', phone: '9000000002', status: 'NEW', joinDate: dayOffset(-31) },
    { name: 'Young', phone: '9000000003', status: 'NEW', joinDate: dayOffset(-5) },
    { name: 'Chase', phone: '9000000004', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-5) },
    { name: 'Fresh', phone: '9000000005', status: 'CALLED', joinDate: dayOffset(-33), callDate: dayOffset(-1) },
    { name: 'Keen', phone: '9000000006', status: 'CALLED', joinDate: dayOffset(-60), callDate: dayOffset(-20), callResult: 'interested' },
    { name: 'Nope', phone: '9000000007', status: 'CALLED', joinDate: dayOffset(-60), callDate: dayOffset(-20), callResult: 'not-interested' },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handlePending();

  assert.match(out, /MONTH UP — pitch the app \(2\)/);
  assert.ok(out.indexOf('Old') < out.indexOf('Due'), 'longest-waiting first');
  assert.ok(!out.includes('Young'), 'not yet a month');
  assert.match(out, /CALLED, no answer recorded — try again \(1\)/);
  assert.ok(out.includes('Chase'), 'past the chase window, still no answer');
  assert.ok(!out.includes('Fresh'), 'called yesterday, too soon');
  assert.ok(!out.includes('Keen'), 'answer logged — resolved');
  assert.ok(!out.includes('Nope'), 'answer logged — resolved');
});

test('pending on an empty queue names who is up next', async () => {
  const store = fakeStore([{ name: 'Soon', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-28) }]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handlePending();
  assert.match(out, /Nobody to call right now/);
  assert.match(out, /Next up: Soon in 2 day\(s\)/);
});

test('called logs the call and date, and never touches a group', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) }]);
  const gm = fakeGroupManager();
  const t = createTrackerHandlers(store, gm, trackerConfig(tmp()), log);

  const out = await t.handleCalled(['9000000001']);
  assert.deepEqual(store.writes[0].updates, { status: 'CALLED', callDate: dayOffset(0) });
  assert.equal(gm.calls.length, 0, 'the bot must NEVER remove anyone');
  assert.match(out, /No answer recorded/);
  assert.match(out, /Reappears in "pending" after 3 day\(s\)/);
});

test('called again on the same person re-stamps the date and says so', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-7) },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handleCalled(['9000000001']);
  assert.equal(store.writes[0].updates.callDate, dayOffset(0));
  assert.match(out, /called .* \(again\)/);
});

test('logging an outcome never removes anyone from a group', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) },
    { name: 'B', phone: '9000000002', status: 'NEW', joinDate: dayOffset(-31) },
  ]);
  const gm = fakeGroupManager();
  const t = createTrackerHandlers(store, gm, trackerConfig(tmp()), log);

  const yes = await t.handleCalled(['9000000001', 'interested']);
  const no = await t.handleCalled(['9000000002', 'not', 'interested']);
  assert.equal(gm.calls.length, 0, 'no group op on either outcome');
  assert.equal(store.writes[0].updates.callResult, 'interested');
  assert.equal(store.writes[1].updates.callResult, 'not-interested');
  assert.match(yes, /kick 9000000001/, 'tells the operator removal is THEIR job');
  assert.match(no, /kick 9000000002/);
});

test('an outcome can be corrected later, in either direction', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40), callResult: 'not-interested' },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  await t.handleCalled(['9000000001', 'interested']);
  assert.equal(store.writes[0].updates.callResult, 'interested');
});

test('called rejects bad input and unknown members without writing', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-60) }]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  assert.match(await t.handleCalled([]), /Format: called/);
  assert.match(await t.handleCalled(['123']), /Invalid number/);
  // Unknown number is no longer a dead end — it asks for a name instead of writing.
  assert.match(await t.handleCalled(['9999999999']), /isn't in the sheet/);
  assert.match(await t.handleCalled(['9000000001', 'maybe']), /Unknown outcome/);
  assert.equal(store.writes.length, 0);
});

test('moved is gone from the tracker handlers entirely', () => {
  const t = createTrackerHandlers(fakeStore([]), fakeGroupManager(), trackerConfig(tmp()), log);
  assert.equal(t.handleMoved, undefined, 'the bot no longer converts or removes anyone');
  assert.deepEqual(Object.keys(t).sort(), ['handleCalled', 'handleLog', 'handlePending']);
});

test('log buckets everyone: interested, not interested, no answer, not called', async () => {
  const store = fakeStore([
    { name: 'N1', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) },
    { name: 'N2', phone: '9000000002', status: 'NEW', joinDate: dayOffset(-2) },
    { name: 'C1', phone: '9000000003', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-6) },
    { name: 'Y1', phone: '9000000004', status: 'CALLED', joinDate: dayOffset(-50), callDate: dayOffset(-20), callResult: 'interested' },
    { name: 'Y2', phone: '9000000005', status: 'CALLED', joinDate: dayOffset(-55), callDate: dayOffset(-25), callResult: 'interested' },
    { name: 'X1', phone: '9000000006', status: 'CALLED', joinDate: dayOffset(-70), callDate: dayOffset(-30), callResult: 'not-interested' },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const parts = await t.handleLog();
  assert.ok(Array.isArray(parts), 'log returns message parts');
  const out = parts.join('\n');

  assert.match(out, /Called: 4/);
  assert.match(out, /Not called yet: 2/);
  assert.match(out, /✅ INTERESTED \(2\)/);
  assert.match(out, /❌ NOT INTERESTED \(1\)/);
  assert.match(out, /📞 CALLED, no answer recorded \(1\)/);
  assert.match(out, /⏳ NOT CALLED YET \(2\) — 1 due now/);
  assert.match(out, /Of 3 who answered, 2 were interested \(67%\)/);
  // Everybody must appear somewhere — this is a log, not a summary.
  for (const p of ['9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '9000000006']) {
    assert.ok(out.includes(p), `${p} missing from the log`);
  }
  assert.ok(!/MOVED/.test(out), 'no MOVED bucket any more');
});

test('log splits into multiple messages when the record is long', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    name: `Member Number ${i}`,
    phone: `90000${String(i).padStart(5, '0')}`,
    status: 'CALLED',
    joinDate: dayOffset(-40),
    callDate: dayOffset(-10),
    callResult: 'interested',
  }));
  const t = createTrackerHandlers(fakeStore(many), fakeGroupManager(), trackerConfig(tmp()), log);
  const parts = await t.handleLog();
  assert.ok(parts.length > 1, 'must split');
  assert.ok(parts.every(p => p.length <= 4096), 'every part fits one WhatsApp message');
  const joined = parts.join('\n');
  for (const m of many) assert.ok(joined.includes(m.phone), `${m.phone} dropped`);
});

// ── profile gating ───────────────────────────────────────────────────────────

test('tracker bots register ZERO cron jobs', () => {
  const lines = [];
  const capturing = { info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };
  const scheduler = createScheduler({
    schedule: { reminderSend: '30 6 * * *', overdueCheck: '0 10 * * *', timezone: 'Asia/Kolkata' },
  }, capturing);

  // index.js gates scheduler.start() behind isTracker, so a tracker never reaches it.
  assert.equal(isTracker({ profile: 'tracker' }), true);
  scheduler.stop();
  assert.equal(lines.filter(l => l.startsWith('⏰ Scheduled')).length, 0, 'nothing scheduled without start()');
});

test('renewal commands are refused on a tracker bot with a helpful message', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) }]);
  const parser = createCommandParser(
    store, fakeGroupManager(), trackerConfig(tmp()), log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );

  for (const cmd of ['renewed 9000000001', 'remind 9000000001', 'due', 'overdue', 'refs 9000000001', 'dmlist 7', 'kickall']) {
    const out = await parser.parse(cmd);
    assert.match(out, /isn't available on this bot/, `${cmd} refused`);
    assert.match(out, /pending · called \[phone\] · moved \[phone\]/, `${cmd} suggests tracker commands`);
  }
  // catchup was retired with the group-mention path — it is now simply unknown everywhere.
  assert.match(await parser.parse('catchup 8'), /Unknown command/);
  assert.equal(store.writes.length, 0);
});

// SUPERSEDES the old split meaning of `pending`. When the friend bots went back to
// collecting renewals they needed the call list AND the overdue list at once, and one word
// cannot carry two meanings. `pending` is now overdue on BOTH profiles; the call list lives
// in `log`, whose "NOT CALLED YET (N) — M due now" bucket is what tracker `pending` showed.
test('pending means overdue on every profile', async () => {
  const rows = [{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31), billingDate: dayOffset(-3) }];

  for (const profile of ['tracker', 'full']) {
    const cfg = { ...trackerConfig(tmp()), profile };
    const parser = createCommandParser(
      fakeStore(rows), fakeGroupManager(), cfg, log,
      { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
    );
    const out = await parser.parse('pending');
    assert.ok(!/CALL LIST/.test(out), `pending must not be the call list on ${profile}`);
  }
});

test('the call list is still reachable, via log', async () => {
  const rows = [{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31), billingDate: dayOffset(-3) }];
  const parser = createCommandParser(
    fakeStore(rows), fakeGroupManager(), { ...trackerConfig(tmp()), profile: 'full' }, log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );
  const out = await parser.parse('log');
  assert.match(Array.isArray(out) ? out.join(String.fromCharCode(10)) : out, /NOT CALLED YET/);
});

// SUPERSEDES "tracker-only commands are refused on a full-profile bot". The friend bots are
// full profile now and still pitch the app, so refusing call tracking on profile would take
// away work they actually do. These read and write column Q, which every profile has.
test('call tracking works on a full-profile bot', async () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const parser = createCommandParser(
    fakeStore([{ name: 'A', phone: '9000000001', status: 'ACTIVE', joinDate: dayOffset(-31), billingDate: dayOffset(-3) }]),
    fakeGroupManager(), fullConfig, log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );
  for (const cmd of ['called 9000000001', 'calls']) {
    const out = await parser.parse(cmd);
    assert.ok(!/tracker-profile command/.test(Array.isArray(out) ? out.join(String.fromCharCode(10)) : out),
      `"${cmd}" must not be refused on a full bot`);
  }
  // `moved` stays retired on every profile — it is gone, not profile-gated.
  assert.match(await parser.parse('moved 9000000001'), /is gone/);
});

// ── reports ──────────────────────────────────────────────────────────────────

test('revenue counts joining fees only and applies the configured split', async () => {
  const thisMonth = dayOffset(-1);
  const store = fakeStore([
    { name: 'J1', phone: '9000000001', status: 'NEW', joinDate: thisMonth, paidLast: 100, billingDate: dayOffset(29) },
    { name: 'J2', phone: '9000000002', status: 'CALLED', joinDate: thisMonth, paidLast: 100, billingDate: dayOffset(29), callDate: dayOffset(0) },
    { name: 'S1', phone: '9000000003', status: 'NEW', joinDate: thisMonth, paidLast: 0, billingDate: dayOffset(29) },
    { name: 'K1', phone: '9000000004', status: 'CALLED', joinDate: dayOffset(-200), paidLast: 100, billingDate: dayOffset(-170), callResult: 'interested' },
  ]);
  const r = createReportHandlers(store, trackerConfig(tmp()), Date.now(), log);
  const out = await r.handleRevenue();

  assert.match(out, /Total: ₹200/, 'two paid joins at 100; silent add excluded');
  assert.match(out, /joins only — this bot collects no renewals/);
  assert.ok(!/Renewals:/.test(out), 'no renewals line at all');
  assert.match(out, /A: ₹120/);
  assert.match(out, /B: ₹40/);
  assert.match(out, /C: ₹40/);
  assert.match(out, /Interested in the app, all time: 1/);
  assert.ok(!/Moved/.test(out), 'nothing claims anyone was moved');
});

test('tracker summary is a money report only — joins, revenue, split, never calls', async () => {
  const store = fakeStore([
    { name: 'J1', phone: '9000000001', status: 'NEW', joinDate: dayOffset(0), paidLast: 100, billingDate: dayOffset(30) },
    { name: 'S1', phone: '9000000004', status: 'NEW', joinDate: dayOffset(0), paidLast: 0, billingDate: dayOffset(30) },
    { name: 'C1', phone: '9000000002', status: 'CALLED', joinDate: dayOffset(-31), callDate: dayOffset(0), paidLast: 100, callResult: 'interested' },
    { name: 'C2', phone: '9000000003', status: 'CALLED', joinDate: dayOffset(-31), callDate: dayOffset(0), paidLast: 100, callResult: 'not-interested' },
  ]);
  const r = createReportHandlers(store, trackerConfig(tmp()), Date.now(), log);
  const out = await r.handleSummary();

  assert.match(out, /📊 Daily Summary — Today/);
  assert.match(out, /New Members: 2 \(₹100\)/, 'silent add is listed but earns nothing');
  assert.match(out, /Today's Revenue: ₹100/);
  assert.match(out, /A: ₹60/);
  assert.match(out, /B: ₹20/);
  assert.match(out, /C: ₹20/);
  assert.match(out, /Removals: 0/);
  assert.match(out, /Total in groups: 4/);

  // Call activity belongs to `log`, not here.
  assert.ok(!/Called/.test(out), 'no call block');
  assert.ok(!/interested/i.test(out), 'no outcome split');
  assert.ok(!/Renewals/.test(out), 'no renewal section');
  assert.ok(!/Moved/.test(out));
});

test('tracker help lists the funnel and no renewal commands', () => {
  const r = createReportHandlers(fakeStore([]), trackerConfig(tmp()), Date.now(), log);
  const out = r.handleHelp(['all']);
  assert.match(out, /BOT COMMANDS — tracker/);
  assert.match(out, /add → \(30 days pass\) → pending → call them → log what they said/);
  assert.ok(!/renewed \[phone\]/.test(out), 'no renewal commands offered');
  assert.ok(!/remindall/.test(out));
  assert.match(out, /NO scheduled jobs/);
});

test('full-profile help is unchanged and still lists renewals', () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const r = createReportHandlers(fakeStore([]), fullConfig, Date.now(), log);
  const out = r.handleHelp(['all']);
  assert.match(out, /💰 RENEWALS/);
  assert.match(out, /renewed \[phone\]/);
  assert.ok(!/BOT COMMANDS — tracker/.test(out));
});

test('full-profile help documents dmlist and drops the retired commands', () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const out = createReportHandlers(fakeStore([]), fullConfig, Date.now(), log).handleHelp(['all']);

  assert.match(out, /• dmlist2\s+→\s+5 days overdue/, 'the 2nd-message command is documented');
  assert.match(out, /• dmlist3\s+→\s+6\+ days overdue/, 'the final-notice command is documented');
  assert.match(out, /dmlist \[1-31\] msg2\|msg3/, 'the forced-stage form is documented');
  assert.match(out, /BILLING DATE, not a window/, 'the changed meaning of the number is called out');
  assert.match(out, /Day 1:\s+dmlist 27\b/, 'the backlog recipe is spelled out');
  assert.match(out, /final notice as\n?\s*their first ever message/, 'says WHY forcing matters');
  assert.match(out, /Nothing goes out on a timer/, 'operator must know the crons are idle');

  assert.ok(!/remindall/.test(out), 'remindall is gone');
  assert.ok(!/catchup/.test(out), 'catchup is gone');
});

test('tracker help documents the three call outcomes and the log command', () => {
  const out = createReportHandlers(fakeStore([]), trackerConfig(tmp()), Date.now(), log).handleHelp(['all']);
  assert.match(out, /called \[phone\] interested/);
  assert.match(out, /called \[phone\] not interested/);
  assert.match(out, /logs the call \+ date, no answer yet/, 'the empty outcome is documented');
  assert.match(out, /re-run later to correct what you logged/, 'says it is correctable');
  assert.match(out, /• log  →  the full record/);
  // The whole point of this rework: the bot records, it does not act.
  assert.match(out, /never removes anyone/);
  assert.ok(!/• moved \[phone\]/.test(out), 'moved is gone from help');
  assert.ok(!/dmlist/.test(out), 'tracker bots collect no renewals, so no dm list');
});

test('moved returns a helpful hint instead of a bare unknown-command error', async () => {
  const parser = createCommandParser(
    fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-40) }]),
    fakeGroupManager(), trackerConfig(tmp()), log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null,
  );
  const out = await parser.parse('moved 9000000001');
  assert.match(out, /"moved" is gone/);
  assert.match(out, /called 9000000001 interested/, 'points at the replacement');
  assert.match(out, /kick 9000000001/, 'says how to actually remove them');
});

test('log and calls are the same command on a tracker bot', async () => {
  const rows = [{ name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-5), callResult: 'interested' }];
  const parser = createCommandParser(
    fakeStore(rows), fakeGroupManager(), trackerConfig(tmp()), log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null,
  );
  const viaLog = await parser.parse('log');
  const viaCalls = await parser.parse('calls');
  assert.deepEqual(viaLog, viaCalls);
  assert.match(viaLog.join('\n'), /CALL LOG/);
});
