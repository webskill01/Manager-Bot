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

test('isCallDue: only NEW members are ever due — CALLED and MOVED are out of the queue', () => {
  for (const status of ['CALLED', 'MOVED', 'REMOVED', 'ACTIVE']) {
    assert.equal(isCallDue({ status, joinDate: dayOffset(-60) }, 30), false, `${status} not due`);
  }
});

test('isCallDue: a configurable window is respected, junk dates are safe', () => {
  assert.equal(isCallDue({ status: 'NEW', joinDate: dayOffset(-10) }, 7), true);
  assert.equal(isCallDue({ status: 'NEW', joinDate: '' }, 30), false);
  assert.equal(isCallDue(null, 30), false);
});

test('needsFollowUp: CALLED resurfaces after the chase window, MOVED never does', () => {
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-3) }, 3), true);
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: dayOffset(-2) }, 3), false);
  assert.equal(needsFollowUp({ status: 'MOVED', callDate: dayOffset(-30) }, 3), false);
  assert.equal(needsFollowUp({ status: 'NEW', callDate: '' }, 3), false);
  assert.equal(needsFollowUp({ status: 'CALLED', callDate: '' }, 3), true, 'called but undated is always worth chasing');
});

test('isTracker only matches the tracker profile', () => {
  assert.equal(isTracker({ profile: 'tracker' }), true);
  assert.equal(isTracker({ profile: 'full' }), false);
  assert.equal(isTracker({}), false);
  assert.equal(isTracker(null), false);
});

// ── pending / called / moved / calls ─────────────────────────────────────────

test('pending splits the month-up list from the chase list, oldest first', async () => {
  const store = fakeStore([
    { name: 'Old', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-45) },
    { name: 'Due', phone: '9000000002', status: 'NEW', joinDate: dayOffset(-31) },
    { name: 'Young', phone: '9000000003', status: 'NEW', joinDate: dayOffset(-5) },
    { name: 'Chase', phone: '9000000004', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-5) },
    { name: 'Fresh', phone: '9000000005', status: 'CALLED', joinDate: dayOffset(-33), callDate: dayOffset(-1) },
    { name: 'Done', phone: '9000000006', status: 'MOVED', joinDate: dayOffset(-60), callDate: dayOffset(-20) },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handlePending();

  assert.match(out, /MONTH UP — pitch the app \(2\)/);
  assert.ok(out.indexOf('Old') < out.indexOf('Due'), 'longest-waiting first');
  assert.ok(!out.includes('Young'), 'not yet a month');
  assert.match(out, /CALLED BUT NOT MOVED — chase again \(1\)/);
  assert.ok(out.includes('Chase'), 'past the chase window');
  assert.ok(!out.includes('Fresh'), 'called yesterday, too soon');
  assert.ok(!out.includes('Done'), 'already moved');
});

test('pending on an empty queue names who is up next', async () => {
  const store = fakeStore([{ name: 'Soon', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-28) }]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handlePending();
  assert.match(out, /Nobody to call right now/);
  assert.match(out, /Next up: Soon in 2 day\(s\)/);
});

test('called marks CALLED with today stamped, and leaves them in the group', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) }]);
  const gm = fakeGroupManager();
  const t = createTrackerHandlers(store, gm, trackerConfig(tmp()), log);

  const out = await t.handleCalled(['9000000001']);
  assert.deepEqual(store.writes[0].updates, { status: 'CALLED', callDate: dayOffset(0) });
  assert.equal(gm.calls.length, 0, 'called must NOT remove anyone from a group');
  assert.match(out, /marked CALLED/);
  assert.match(out, /Still in the group/);
});

test('called again on the same person re-stamps the date and says so', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-7) },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handleCalled(['9000000001']);
  assert.equal(store.writes[0].updates.callDate, dayOffset(0));
  assert.match(out, /called again/);
});

test('moved removes from every group and marks MOVED', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-5) },
  ]);
  const gm = fakeGroupManager();
  const t = createTrackerHandlers(store, gm, trackerConfig(tmp()), log);

  const out = await t.handleMoved(['9000000001']);
  assert.deepEqual(gm.calls, ['9000000001'], 'removed from groups');
  assert.equal(store.writes[0].updates.status, 'MOVED');
  assert.equal(store.writes[0].updates.callDate, dayOffset(-5), 'original call date preserved');
  assert.match(out, /Removed from 2\/2 group/);
});

test('moved on someone never called still works and stamps a call date', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) }]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  await t.handleMoved(['9000000001']);
  assert.equal(store.writes[0].updates.callDate, dayOffset(0));
});

test('moved surfaces partial group-removal failures instead of hiding them', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'CALLED', joinDate: dayOffset(-40) }]);
  const gm = fakeGroupManager({ removed: ['g1@g.us'], failed: ['g2@g.us'] });
  const t = createTrackerHandlers(store, gm, trackerConfig(tmp()), log);
  const out = await t.handleMoved(['9000000001']);
  assert.match(out, /Removed from 1\/2/);
  assert.match(out, /1 group\(s\) failed — re-run: kick 9000000001/);
});

test('called / moved reject bad input and unknown or already-moved members', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'MOVED', joinDate: dayOffset(-60) }]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  assert.match(await t.handleCalled([]), /Format: called/);
  assert.match(await t.handleCalled(['123']), /Invalid number/);
  assert.match(await t.handleMoved(['9999999999']), /No member found/);
  assert.match(await t.handleCalled(['9000000001']), /already MOVED/);
  assert.match(await t.handleMoved(['9000000001']), /already MOVED/);
  assert.equal(store.writes.length, 0);
});

test('calls reports the funnel and conversion rate', async () => {
  const store = fakeStore([
    { name: 'N1', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31) },
    { name: 'N2', phone: '9000000002', status: 'NEW', joinDate: dayOffset(-2) },
    { name: 'C1', phone: '9000000003', status: 'CALLED', joinDate: dayOffset(-40), callDate: dayOffset(-6) },
    { name: 'M1', phone: '9000000004', status: 'MOVED', joinDate: dayOffset(-50), callDate: dayOffset(-20) },
    { name: 'M2', phone: '9000000005', status: 'MOVED', joinDate: dayOffset(-55), callDate: dayOffset(-25) },
    { name: 'R1', phone: '9000000006', status: 'REMOVED', joinDate: dayOffset(-70) },
  ]);
  const t = createTrackerHandlers(store, fakeGroupManager(), trackerConfig(tmp()), log);
  const out = await t.handleCalls();

  assert.match(out, /NEW \(in group, not called\):  2/);
  assert.match(out, /month up, call now:       1/);
  assert.match(out, /CALLED \(pitched, not moved\): 1/);
  assert.match(out, /MOVED \(on the app\):          2/);
  assert.match(out, /REMOVED \(dropped\):           1/);
  assert.match(out, /Conversion: 2\/3 pitched → app \(67%\)/);
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

test('pending routes to the call list on a tracker and the overdue list on a full bot', async () => {
  const rows = [{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: dayOffset(-31), billingDate: dayOffset(-3) }];

  const trackerParser = createCommandParser(
    fakeStore(rows), fakeGroupManager(), trackerConfig(tmp()), log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );
  assert.match(await trackerParser.parse('pending'), /CALL LIST/);

  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const fullParser = createCommandParser(
    fakeStore(rows), fakeGroupManager(), fullConfig, log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );
  const out = await fullParser.parse('pending');
  assert.ok(!/CALL LIST/.test(out), 'full profile keeps the renewal meaning of pending');
});

test('tracker-only commands are refused on a full-profile bot', async () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const parser = createCommandParser(
    fakeStore([]), fakeGroupManager(), fullConfig, log,
    { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null, null,
  );
  for (const cmd of ['called 9000000001', 'moved 9000000001', 'calls']) {
    assert.match(await parser.parse(cmd), /tracker-profile command/);
  }
});

// ── reports ──────────────────────────────────────────────────────────────────

test('tracker revenue counts joining fees only and splits 60-20-20', async () => {
  const thisMonth = dayOffset(-1);
  const store = fakeStore([
    { name: 'J1', phone: '9000000001', status: 'NEW', joinDate: thisMonth, paidLast: 100, billingDate: dayOffset(29) },
    { name: 'J2', phone: '9000000002', status: 'CALLED', joinDate: thisMonth, paidLast: 100, billingDate: dayOffset(29), callDate: dayOffset(0) },
    { name: 'S1', phone: '9000000003', status: 'NEW', joinDate: thisMonth, paidLast: 0, billingDate: dayOffset(29) },
    { name: 'M1', phone: '9000000004', status: 'MOVED', joinDate: dayOffset(-200), paidLast: 100, billingDate: dayOffset(-170) },
  ]);
  const r = createReportHandlers(store, trackerConfig(tmp()), Date.now(), log);
  const out = r.handleRevenue();

  assert.match(out, /Total: ₹200/, 'two paid joins at 100; silent add excluded');
  assert.match(out, /joins only — this bot collects no renewals/);
  assert.ok(!/Renewals:/.test(out), 'no renewals line at all');
  assert.match(out, /A: ₹120/);
  assert.match(out, /B: ₹40/);
  assert.match(out, /C: ₹40/);
  assert.match(out, /Moved to app, all time: 1/);
});

test('tracker summary reports joins, calls and moves — never renewals', async () => {
  const store = fakeStore([
    { name: 'J1', phone: '9000000001', status: 'NEW', joinDate: dayOffset(0), paidLast: 100, billingDate: dayOffset(30) },
    { name: 'C1', phone: '9000000002', status: 'CALLED', joinDate: dayOffset(-31), callDate: dayOffset(0), paidLast: 100 },
  ]);
  const r = createReportHandlers(store, trackerConfig(tmp()), Date.now(), log);
  const out = await r.handleSummary();

  assert.match(out, /Joined: 1 \(₹100\)/);
  assert.match(out, /Called: 1/);
  assert.match(out, /Moved to app: 0/);
  assert.ok(!/Renewals/.test(out), 'no renewal section');
  assert.match(out, /See the list: pending/);
});

test('tracker help lists the funnel and no renewal commands', () => {
  const r = createReportHandlers(fakeStore([]), trackerConfig(tmp()), Date.now(), log);
  const out = r.handleHelp();
  assert.match(out, /BOT COMMANDS — tracker/);
  assert.match(out, /pending → called → moved|add → \(30 days pass\) → pending → called → moved/);
  assert.ok(!/renewed \[phone\]/.test(out), 'no renewal commands offered');
  assert.ok(!/remindall/.test(out));
  assert.match(out, /NO scheduled jobs/);
});

test('full-profile help is unchanged and still lists renewals', () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const r = createReportHandlers(fakeStore([]), fullConfig, Date.now(), log);
  const out = r.handleHelp();
  assert.match(out, /💰 RENEWALS/);
  assert.match(out, /renewed \[phone\]/);
  assert.ok(!/BOT COMMANDS — tracker/.test(out));
});

test('full-profile help documents dmlist and drops the retired commands', () => {
  const fullConfig = { ...trackerConfig(tmp()), profile: 'full' };
  const out = createReportHandlers(fakeStore([]), fullConfig, Date.now(), log).handleHelp();

  assert.match(out, /dmlist \[days\] msg1\|msg2\|msg3/, 'the forced-stage form is documented');
  assert.match(out, /Day 1:\s+dmlist 7 msg1/, 'the backlog recipe is spelled out');
  assert.match(out, /final notice as their first ever message/, 'says WHY forcing matters');
  assert.match(out, /Nothing goes out on a timer/, 'operator must know the crons are idle');

  assert.ok(!/remindall/.test(out), 'remindall is gone');
  assert.ok(!/catchup/.test(out), 'catchup is gone');
});

test('tracker help documents the interested / not interested outcomes', () => {
  const out = createReportHandlers(fakeStore([]), trackerConfig(tmp()), Date.now(), log).handleHelp();
  assert.match(out, /called \[phone\] interested/);
  assert.match(out, /called \[phone\] not interested/);
  assert.match(out, /Drops OUT of "pending"/, 'explains what a "no" actually does');
  assert.match(out, /changed their mind\? called \[phone\] interested/i, 'says it is reversible');
  assert.ok(!/dmlist/.test(out), 'tracker bots collect no renewals, so no send list');
});
