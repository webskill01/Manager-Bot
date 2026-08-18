import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDripIds } from '../core/globalConfig.js';

test('dripIds falls back to every allowed id when unset', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: ['1', '2'] }), ['1', '2']);
});

test('dripIds narrows to the configured owner', () => {
  assert.deepEqual(
    resolveDripIds({ allowedTelegramIds: ['1', '2', '3'], dripIds: ['3'] }),
    ['3'],
  );
});

test('dripIds coerces numbers to strings', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: [], dripIds: [42] }), ['42']);
});

test('an empty dripIds is treated as unset, not as "nobody"', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: ['1'], dripIds: [] }), ['1']);
});

test('no telegram config at all yields an empty list, never undefined', () => {
  assert.deepEqual(resolveDripIds({}), []);
});

// ── batch building ─────────────────────────────────────────────────────────────
import { buildDripBatch } from '../core/dripEngine.js';

const cfg = {
  joining: { fee: 90 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name} {date}', overdue: 'late {name}', finalReminder: 'final {name}' },
};

// Billing dates are computed off the REAL today: buildDmList calls daysFromToday(), which
// has no injectable clock, so a hardcoded date would make these tests pass only on one day.
// Format is DD-MM-YYYY — parseDate reads [day, month, year], NOT ISO. Getting this backwards
// silently yields ~39,000-day overdue values that land everyone in the final cohort.
function member(name, phone, overdueDays) {
  const d = new Date();
  d.setDate(d.getDate() - overdueDays);
  const billing = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  return { name, phone, billingDate: billing, status: 'ACTIVE', renewals: 0 };
}

test('a batch takes at most one member from each of the three cohorts', () => {
  const members = [
    member('DueA', '9000000001', 0), member('DueB', '9000000002', 0),
    member('NudgeA', '9000000003', 5), member('NudgeB', '9000000004', 5),
    member('FinalA', '9000000005', 6),
  ];
  const batch = buildDripBatch({ members, config: cfg, pushed: [] });
  assert.equal(batch.length, 3);
  assert.deepEqual(batch.map(r => r.stage).sort(), ['msg1', 'msg2', 'msg3']);
});

test('already-pushed phones never come back', () => {
  const members = [member('DueA', '9000000001', 0), member('DueB', '9000000002', 0)];
  const batch = buildDripBatch({ members, config: cfg, pushed: ['9000000001'] });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].phone, '9000000002');
});

test('an empty batch means the day is done', () => {
  const members = [member('DueA', '9000000001', 0)];
  assert.deepEqual(buildDripBatch({ members, config: cfg, pushed: ['9000000001'] }), []);
});

test('every row carries a wa.me link with the message pre-typed', () => {
  const [row] = buildDripBatch({ members: [member('DueA', '9000000001', 0)], config: cfg, pushed: [] });
  assert.ok(row.link.startsWith('https://wa.me/919000000001?text='));
  assert.ok(decodeURIComponent(row.link.split('?text=')[1]).includes('DueA'));
});

test('one member cannot appear twice in a batch via two cohorts', () => {
  // A 6-day-overdue member matches BOTH the nudge window edge and the final cohort on a
  // bot whose ladder is tight enough. Sending them two links in one push reads as a bug.
  const tight = { ...cfg, overdue: { autoReminderDays: 6, finalReminderDays: 6, consolidatedListDays: 7 } };
  const batch = buildDripBatch({ members: [member('X', '9000000009', 6)], config: tight, pushed: [] });
  assert.equal(batch.length, 1);
});

// ── window and tick loop ───────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withinWindow, dripSettings, createDripEngine, countRemaining } from '../core/dripEngine.js';

// A temp dir, never a real bot's — tests/telegram.test.js once asserted against
// bots/bot-abhi/config.json and broke the day real ids were added to it.
const tempBotDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drip-'));
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function engineCfg(extra = {}) {
  return { ...cfg, botDir: tempBotDir(), drip: { startHour: 0, endHour: 24 }, ...extra };
}

test('the window opens at 9 and closes at 21', () => {
  const s = dripSettings({});
  assert.equal(withinWindow(new Date('2026-08-18T08:59:00'), s), false);
  assert.equal(withinWindow(new Date('2026-08-18T09:00:00'), s), true);
  assert.equal(withinWindow(new Date('2026-08-18T20:59:00'), s), true);
  assert.equal(withinWindow(new Date('2026-08-18T21:00:00'), s), false);
});

test('config overrides the window', () => {
  const s = dripSettings({ drip: { startHour: 10, endHour: 18 } });
  assert.equal(withinWindow(new Date('2026-08-18T09:30:00'), s), false);
  assert.equal(withinWindow(new Date('2026-08-18T17:59:00'), s), true);
});

test('defaults are an 18-25 minute range', () => {
  const s = dripSettings({});
  assert.equal(s.gapMinMs, 18 * 60 * 1000);
  assert.equal(s.gapMaxMs, 25 * 60 * 1000);
});

test('countRemaining dedupes a member who matches two cohorts', () => {
  const tight = { ...cfg, overdue: { autoReminderDays: 6, finalReminderDays: 6, consolidatedListDays: 7 } };
  assert.equal(countRemaining({ members: [member('X', '9000000009', 6)], config: tight, pushed: [] }), 1);
});

test('a tick pushes one batch and records it', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('wa.me'), 'the operator gets a tap-link, not a sent message');
  assert.ok(engine.status().includes('1 pushed'));
});

test('a member who pays mid-drip drops out of the rest of the day', async () => {
  const calls = [];
  let paid = false;
  const store = {
    refresh: async () => {},
    getAll: () => [
      member('A', '9000000001', 0),
      { ...member('B', '9000000002', 0), status: paid ? 'REMOVED' : 'ACTIVE' },
      // C keeps the second tick doing real work, so the assertion below is about B being
      // skipped rather than about the day simply having ended.
      member('C', '9000000003', 0),
    ],
  };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });
  await engine.tick();
  assert.ok(calls[0].includes('9000000001'));
  paid = true;
  await engine.tick();
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].includes('9000000002'), 'B paid — chasing them anyway is the bug this prevents');
  assert.ok(calls[1].includes('9000000003'));
});

test('outside the window a tick finishes the day instead of pushing', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(
    engineCfg({ drip: { startHour: 0, endHour: 0 } }),   // never open
    quietLog, store, { autoRenewDue: async () => [] }, async (t) => { calls.push(t); },
  );
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('Drip finished'));
  assert.ok(!calls[0].includes('wa.me'));
});

test('the end-of-day report names how many were not reached', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(
    engineCfg({ drip: { startHour: 0, endHour: 0 } }),
    quietLog, store, { autoRenewDue: async () => [] }, async (t) => { calls.push(t); },
  );
  await engine.tick();
  assert.ok(calls[0].includes('1 NOT reached today'), 'a silent drop is the one thing this must not do');
});

test('stop halts pushing and start clears the halt', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });
  engine.stop();
  await engine.tick();
  assert.equal(calls.length, 0, 'a stopped drip must push nothing');
  assert.ok(engine.status().includes('stopped'));
});

test('drip test pushes a real batch but records nothing', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); return true; });
  const reply = await engine.test();
  assert.ok(calls[0].includes('TEST'));
  assert.ok(calls[0].includes('wa.me'));
  assert.ok(reply.includes('Nothing was recorded'));
  assert.ok(engine.status().includes('0 pushed'), 'a test must not consume the real queue');
});

test('drip test says so when there is nobody to send to', async () => {
  const store = { refresh: async () => {}, getAll: () => [] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async () => true);
  assert.ok((await engine.test()).includes('Nothing to send'));
});

test('arm auto-renews once before the first push', async () => {
  let renewCalls = 0;
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => { renewCalls++; return []; } }, async () => true);
  await engine.arm();
  assert.equal(renewCalls, 1, 'a 2-ref member owes nothing — chasing them is a real error');
});
