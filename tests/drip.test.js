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

// ── the drip and the Cloud API are alternatives, never a pair ─────────────────
// Flipping reminderChannel to "cloudapi" wakes the three reminder crons, which message the
// same members the drip queues links for. Both on = every member reminded twice, once by
// Meta and once by the operator's thumb. Gated at the engine, not just the cron, because
// `drip start` and `drip test` are typed by hand.
const cloudCfg = () => ({
  ...cfg,
  botDir: tempBotDir(),
  drip: { startHour: 0, endHour: 24 },
  reminderChannel: 'cloudapi',
  // token is injected from the gitignored .env at load time, never config.json — but
  // isConfigured() requires it, so a fixture without one would silently make usesCloudApi
  // false and "pass" these tests for the wrong reason.
  cloudApi: {
    phoneNumberId: '1336660736191431',
    token: 'EAA-fake-system-user-token',
    templates: { reminder: 'renewal_due' },
  },
});

function cloudEngine(calls) {
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  return createDripEngine(cloudCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); return true; });
}

test('tick pushes nothing once reminders run through the Cloud API', async () => {
  const calls = [];
  await cloudEngine(calls).tick();
  assert.equal(calls.length, 0, 'double-reminding every member is the bug this prevents');
});

test('arm does nothing once the Cloud API is live', async () => {
  const calls = [];
  await cloudEngine(calls).arm();
  assert.equal(calls.length, 0);
});

test('a hand-typed drip start is refused, with the reason', () => {
  const calls = [];
  const reply = cloudEngine(calls).start();
  assert.match(reply, /Cloud API/);
  assert.equal(calls.length, 0);
});

test('drip test is refused too — it would push real links', async () => {
  const calls = [];
  const reply = await cloudEngine(calls).test();
  assert.match(reply, /Cloud API/);
  assert.equal(calls.length, 0);
});

test('resume after a restart does not revive the drip', () => {
  const calls = [];
  cloudEngine(calls).resume();
  assert.equal(calls.length, 0);
});

// ── auto mode: the bot sends, instead of pushing a link to a thumb ─────────────
import { adaptiveGapMs } from '../core/dripEngine.js';
import { todayStr } from '../core/globalConfig.js';

const HOUR = 60 * 60 * 1000;
const autoSettings = (extra = {}) => dripSettings({ drip: { mode: 'auto', ...extra } });

test('auto mode gets the 6-18 window and a 20 minute floor without config', () => {
  const s = autoSettings();
  assert.equal(s.mode, 'auto');
  assert.equal(s.startHour, 6);
  assert.equal(s.endHour, 18);
  assert.equal(s.gapMinMs, 20 * 60 * 1000);
  assert.equal(withinWindow(new Date('2026-08-25T05:59:00'), s), false);
  assert.equal(withinWindow(new Date('2026-08-25T17:59:00'), s), true);
});

// The whole point of the adaptive gap: a quiet day must not fire at the same rate as a busy
// one just because the rate is what the config says.
test('the gap stretches on a light day and closes up on a heavy one', () => {
  const s = autoSettings();
  const noWobble = () => 0;   // the wobble only adds, so 0 leaves the bare arithmetic
  const gap = (n, hoursLeft) => adaptiveGapMs(n, hoursLeft * HOUR, s, noWobble);

  assert.equal(gap(10, 12), 72 * 60 * 1000, '10 left over 12h → 72m apart');
  assert.equal(gap(24, 12), 30 * 60 * 1000, '24 left over 12h → 30m apart');
});

// The floor is the ban control and outranks the arithmetic: a queue too long for the window
// does NOT get a tighter gap, it gets a shorter tail. Those members roll into tomorrow one
// day more overdue, which the 5/6 ladder absorbs.
// The regression this guards: the wobble was ±20%, so a 20 minute floor produced 16 minute
// gaps — 3.75 an hour — on exactly the busiest days, when the ceiling matters most.
test('the 3-an-hour ceiling holds however long the queue gets, at every roll of the dice', () => {
  const s = autoSettings();
  for (const n of [36, 50, 200, 900]) {
    for (let r = 0; r <= 1; r += 0.05) {
      assert.ok(adaptiveGapMs(n, 12 * HOUR, s, () => r) >= s.gapMinMs,
        n + ' in the queue sent faster than 3 an hour at rand=' + r.toFixed(2));
    }
  }
});

test('a nearly empty day is capped, not spread across the whole window', () => {
  const s = autoSettings();
  assert.equal(adaptiveGapMs(1, 11 * HOUR, s, () => 0), s.gapCapMs);
  assert.equal(adaptiveGapMs(0, 11 * HOUR, s, () => 0), s.gapCapMs);
});

test('no two gaps are the same number — the wobble is real', () => {
  const s = autoSettings();
  const seen = new Set(Array.from({ length: 20 }, (_, i) => adaptiveGapMs(10, 12 * HOUR, s, () => i / 20)));
  assert.ok(seen.size > 15, 'gaps are clustering on one value');
});

// With max:1 the cohort ORDER decides who gets left out on a busy day, and the operator's
// call is renewals before follow-ups: the day-0 reminder is the one that actually collects
// money, so an overflowing day must drop chase-ups and not income. A missed day-0 member
// becomes a nudge tomorrow; a missed day-6 member is already a decision on the removal list.
test('the due-today cohort is served first when only one send fits', () => {
  const members = [
    member('DueA', '9000000001', 0),
    member('NudgeA', '9000000003', 5),
    member('FinalA', '9000000005', 6),
  ];
  const order = [];
  let pushed = [];
  for (let i = 0; i < 3; i++) {
    const [row] = buildDripBatch({ members, config: cfg, pushed, max: 1 });
    order.push(row.stage);
    pushed = [...pushed, row.phone];
  }
  assert.deepEqual(order, ['msg1', 'msg2', 'msg3']);
});

// A fake socket close enough to Baileys for the send path: presence calls plus sendMessage.
function fakeSock() {
  const sent = [];
  const presence = [];
  return {
    sent, presence,
    sock: {
      user: { id: 'bot' },
      async presenceSubscribe(jid) { presence.push('sub:' + jid); },
      async sendPresenceUpdate(state, jid) { presence.push(jid ? state + ':' + jid : state); },
      async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    },
  };
}

test('auto mode sends over WhatsApp itself and pushes no link', async () => {
  const { sock, sent, presence } = fakeSock();
  const notices = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  const engine = createDripEngine(
    // humanDelay left ON here on purpose: this is the test that the real send path — pauses
    // included — reaches sendMessage at all.
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24 } }),
    quietLog, store, { autoRenewDue: async () => [] },
    async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  assert.equal(sent.length, 1, 'the member was not messaged');
  assert.equal(sent[0].jid, '919000000001@s.whatsapp.net');
  assert.ok(sent[0].msg.text.includes('A'), 'the reminder text did not reach the member');
  assert.deepEqual(notices, [], 'auto mode must not buzz the operator per send');
  // Typing before the message, stopped after, then the account drops back to "last seen at"
  // instead of sitting online until the next reminder — the cheapest human tells there are.
  assert.deepEqual(presence, [
    'sub:919000000001@s.whatsapp.net',
    'composing:919000000001@s.whatsapp.net',
    'paused:919000000001@s.whatsapp.net',
    'unavailable',
  ]);
  assert.ok(engine.status().includes('auto-send'));
});

// Auto mode works the queue in the same batches manual mode pushes — one member per cohort,
// three per tick. It used to take one, which on a 929-member sheet left ~23 members unsent
// every single day; see DEFAULT_BATCH_SIZE for the arithmetic.
test('a tick sends the whole batch, one member per cohort', async () => {
  const { sock, sent, presence } = fakeSock();
  const members = [member('A', '9000000001', 0), member('B', '9000000003', 5), member('C', '9000000005', 6)];
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();
  assert.equal(sent.length, 3);
  // Online for the batch, offline once at the end of it — not once per message.
  assert.equal(presence.filter(p => p === 'unavailable').length, 1);
});

// The batch is the ban risk this change introduces, and the gap between its messages is the
// whole mitigation. Asserted through the log line rather than the clock so the check costs
// nothing: two gaps for three messages, none in front of the first, each inside the range.
test('the messages of a batch are spaced, and the first one is not delayed', async () => {
  const { sock, sent } = fakeSock();
  const lines = [];
  const log = { info: (t) => lines.push(t), warn: () => {}, error: () => {} };
  const members = [member('A', '9000000001', 0), member('B', '9000000003', 5), member('C', '9000000005', 6)];
  const engine = createDripEngine(
    engineCfg({ drip: {
      mode: 'auto', startHour: 0, endHour: 24, humanDelay: false,
      msgGapMinMs: 30000, msgGapMaxMs: 90000,
    } }),
    log, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  const gaps = lines.filter(t => t.includes('Next in this batch'))
    .map(t => Number(t.match(/(\d+)s/)[1]));
  assert.equal(sent.length, 3);
  assert.equal(gaps.length, 2, 'three messages need two gaps, and none before the first');
  for (const g of gaps) {
    assert.ok(g >= 30 && g <= 90, `gap ${g}s fell outside the configured 30-90s`);
  }
});

// A socket hiccup must not mark someone as reminded — they are still owed a message.
test('a dead socket costs a slot, never a member', async () => {
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => null, warmingUp: () => false },
  );
  await engine.tick();
  assert.ok(engine.status().includes('0 sent by the bot'), 'a failed send was recorded as done');
});

// Auto mode transmits, so unlike manual mode it is subject to warm-up. A freshly linked
// number whose first act is a paced reminder run is exactly the profile that gets flagged.
test('warm-up holds the auto send', async () => {
  const { sock, sent } = fakeSock();
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => true },
  );
  await engine.tick();
  assert.equal(sent.length, 0);
});

// The capability, not the config, is what gates auto mode: core/telegram.js hands no sender,
// so a Telegram-only bot stays manual whatever someone writes in its config.json.
test('auto mode without a socket falls back to pushing links', async () => {
  const notices = [];
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
  );
  await engine.tick();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('wa.me'));
});

test('a QR list rotates per member, and one path still works', async () => {
  const { sock, sent } = fakeSock();
  const dir = tempBotDir();
  for (const f of ['qr-1.jpg', 'qr-2.jpg']) fs.writeFileSync(path.join(dir, f), f);
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0), member('C', '9000000004', 0)];
  const engine = createDripEngine(
    { ...cfg, botDir: dir, upiQrPath: ['./qr-1.jpg', './qr-2.jpg'], drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } },
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 3; i++) await engine.tick();

  assert.equal(sent.length, 3);
  for (const s of sent) assert.ok(s.msg.image, 'the QR did not ride along');
  const used = new Set(sent.map(s => s.msg.image.toString()));
  assert.ok(used.size > 1, 'every member got the byte-identical QR');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The one number the operator must see on the morning it matters: a queue that does not fit
// the window is silently truncated by design, and silently is exactly the failure mode that
// hides for a week.
test('arm warns when the day does not fit, and stays quiet when it does', async () => {
  const { sock } = fakeSock();
  // 12h / (20m x 1.2) = 30 batches x 3 per batch = ~90 members a day. 120 overflows it.
  const many = Array.from({ length: 120 }, (_, i) => member('M' + i, '90000' + String(i).padStart(5, '0'), 0));
  const build = (members) => {
    const notices = [];
    const engine = createDripEngine(
      { ...cfg, botDir: tempBotDir(), drip: { mode: 'auto', humanDelay: false } },
      quietLog, { refresh: async () => {}, getAll: () => members },
      { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
      { getSock: () => sock, warmingUp: () => false },
    );
    return { engine, notices };
  };

  const busy = build(many);
  await busy.engine.arm();
  assert.equal(busy.notices.length, 1, 'a 120-deep queue armed silently');
  assert.match(busy.notices[0], /120 reminders queued, room for about 90/);

  const quiet = build(many.slice(0, 5));
  await quiet.engine.arm();
  assert.deepEqual(quiet.notices, [], 'a five-person day should say nothing');
});

// Media is the heaviest thing this bot transmits and the easiest to fingerprint, so it goes
// out once per member per cycle — not once per message. Three DIFFERENT members, each on
// their own first contact, must therefore each get one.
test('every member gets a QR on their own first contact, whatever stage it is', async () => {
  const { sock, sent } = fakeSock();
  const dir = tempBotDir();
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const members = [
    member('Due', '9000000001', 0),
    member('Nudge', '9000000002', 5),
    member('Final', '9000000004', 6),
  ];
  const engine = createDripEngine(
    { ...cfg, botDir: dir, upiQrPath: ['./qr-1.jpg'], drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } },
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 3; i++) await engine.tick();

  assert.equal(sent.length, 3);
  for (const s of sent) assert.ok(s.msg.image, 'a first contact went out with nothing to pay against');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A restricted number still accepts sendMessage and simply fails to deliver. Retrying that
// for eleven hours is how a warning becomes an escalation.
test('five failures in a row hand the rest of the day over, rather than stopping', async () => {
  const notices = [];
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {},
    async sendPresenceUpdate() {},
    async sendMessage() { throw new Error('forbidden'); },
  };
  const members = Array.from({ length: 10 }, (_, i) => member('M' + i, '90000000' + String(i).padStart(2, '0'), 0));
  const engine = createDripEngine(
    { ...cfg, botDir: tempBotDir(), drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } },
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 5; i++) await engine.tick();

  // The day does not stop — it changes channel. Announced exactly once, however many
  // individual failures preceded it.
  const flips = notices.filter(n => /Handing today over to you/.test(n));
  assert.equal(flips.length, 1, 'the operator was not told, or was told twice');
  assert.match(flips[0], /forbidden/, 'the actual error must reach the operator');
  assert.ok(engine.status().includes('LINK-ONLY'));

  // And every one of them still got chased — that is the whole point of not stopping.
  assert.ok(notices.filter(n => /Send it yourself/.test(n)).length >= 5,
    'members went unchased once the bot could no longer send');

  // And it stays link-only: the flip is announced once, not on every subsequent member.
  const before = notices.filter(n => /Handing today over/.test(n)).length;
  await engine.tick();
  assert.equal(notices.filter(n => /Handing today over/.test(n)).length, before);
});

test('a success clears the streak — an intermittent failure is not a shutdown', async () => {
  const notices = [];
  let calls = 0;
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {},
    async sendPresenceUpdate() {},
    async sendMessage() { if (++calls % 2) throw new Error('blip'); },
  };
  const members = Array.from({ length: 12 }, (_, i) => member('M' + i, '90000000' + String(i).padStart(2, '0'), 0));
  const engine = createDripEngine(
    { ...cfg, botDir: tempBotDir(), drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } },
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 10; i++) await engine.tick();
  assert.deepEqual(notices.filter(n => /Auto-send stopped/.test(n)), [],
    'alternating failures tripped the breaker');
  // Each member's first failure is still reported — one per member, never one per retry.
  const failNotices = notices.filter(n => /Send failed/.test(n));
  assert.equal(new Set(failNotices).size, failNotices.length, 'a member was reported twice');
});

// The hole this closes: 'due' is EXACTLY day 0, so a member missed on their due date never
// gets msg1 at all — their first ever contact is the day-5 nudge. Gating the QR on msg1 meant
// that person was chased for ₹90 twice with no way to pay.
test('someone who never got msg1 still gets the QR on their first real message', async () => {
  const { sock, sent } = fakeSock();
  const dir = tempBotDir();
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const cfgQr = { ...cfg, botDir: dir, upiQrPath: ['./qr-1.jpg'], drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } };

  // Day 5 and day 6. Neither was ever reachable as a day-0 'due' member.
  const members = [member('Nudge', '9000000002', 5), member('Final', '9000000004', 6)];
  const engine = createDripEngine(
    cfgQr, quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 2; i++) await engine.tick();

  assert.equal(sent.length, 2);
  for (const s of sent) assert.ok(s.msg.image, 'a first contact went out with no QR to pay against');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the QR goes once per cycle, then stops until the member renews', async () => {
  const { sock, sent } = fakeSock();
  const dir = tempBotDir();
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const cfgQr = { ...cfg, botDir: dir, upiQrPath: ['./qr-1.jpg'], drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } };
  const build = (members, pushed) => {
    fs.writeFileSync(path.join(dir, 'drip-state.json'),
      JSON.stringify({ date: todayStr(), pushed, stopped: false, done: false, armedAt: null }));
    return createDripEngine(cfgQr, quietLog, { refresh: async () => {}, getAll: () => members },
      { autoRenewDue: async () => [] }, async () => {},
      { getSock: () => sock, warmingUp: () => false });
  };

  // Same member, same billingDate — that string IS the cycle id, so it must stay fixed while
  // the messages escalate. Two sends: the day-5 nudge, then the day-6 final the next morning.
  // `pushed` is cleared between them, which is what a new day does.
  const overdue5 = member('A', '9000000001', 5);
  await build([overdue5], []).tick();
  await build([overdue5], []).tick();
  assert.equal(sent.length, 2);
  assert.ok(sent[0].msg.image, 'first contact of the cycle lost its QR');
  assert.ok(!sent[1].msg.image, 'the QR was re-sent inside one cycle');

  // They pay: billingDate moves forward, which is a new cycle, so the first message of THAT
  // one carries a QR again. Nothing to expire or reset — the date does the bookkeeping.
  await build([member('A', '9000000001', 0)], []).tick();
  assert.equal(sent.length, 3);
  assert.ok(sent[2].msg.image, 'the new cycle did not get a fresh QR');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A QR marked sent on a message that threw would leave that member without one all cycle —
// and now that a failed send is handed to the operator rather than retried, the handoff is
// what has to carry that fact.
test('a failed send hands the member over WITH their QR still owed', async () => {
  const dir = tempBotDir();
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const cfgQr = { ...cfg, botDir: dir, upiQrPath: ['./qr-1.jpg'], drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } };
  const members = [member('A', '9000000001', 0)];
  let fail = true;
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async sendMessage(jid, msg) { if (fail) throw new Error('nope'); sent.push({ jid, msg }); },
  };
  const engine = createDripEngine(
    cfgQr, quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  const notices = [];
  const engine2 = createDripEngine(
    cfgQr, quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine2.tick();

  // Nothing reached the member, so their QR is still owed — and the handoff has to say so,
  // because the operator is the one attaching it now.
  assert.equal(sent.length, 0);
  const handoff = notices.find(n => n.includes('Send it yourself'));
  assert.ok(handoff, 'a failed send never reached the operator');
  assert.ok(handoff.includes('Attach the QR'), 'the operator was not told the QR is still owed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the group-membership gate ─────────────────────────────────────────────────
//
// Someone who left the groups and is still chased for ₹90 is the most likely person in the
// whole sheet to press "report", and reports are what get numbers banned — not volume.

const GROUPS = ['120363000000000001@g.us', '120363000000000002@g.us'];

// A socket whose groups contain exactly `phones`. Counts roster reads so the "once a day"
// promise is actually checked rather than assumed.
// `lids` maps a phone to the @lid Baileys has cached for it, which is how the engine matches
// a member the groups only ever named by LID. A phone absent from BOTH maps is one the bot
// has never messaged, and no roster can prove anything about them.
function sockWithGroups(phones, lids = {}) {
  const sent = [];
  const state = { fetches: 0 };
  return {
    sent, state,
    sock: {
      user: { id: 'bot' },
      async presenceSubscribe() {}, async sendPresenceUpdate() {},
      async sendMessage(jid, msg) { sent.push({ jid, msg }); },
      signalRepository: {
        lidMapping: {
          getLIDForPN: async (jid) => lids[jid.replace(/\D/g, '').slice(-10)] || null,
        },
      },
      async groupFetchAllParticipating() {
        state.fetches++;
        return Object.fromEntries(GROUPS.map((id, i) => [id, {
          id,
          // Split across the two groups, and throw in a LID-only participant: a real LID-era
          // group is full of them, and they are why absence from the PHONE set alone proves
          // nothing.
          participants: [
            ...phones.filter((_, n) => n % 2 === i).map(p => ({ id: `${p}@s.whatsapp.net` })),
            { id: '99887766554433@lid' },
          ],
        }]));
      },
    },
  };
}

const rosterCfg = (dir) => ({
  ...cfg, botDir: dir, paidGroups: GROUPS,
  drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false },
});

test('a member who left every group is not messaged, and is named at day end', async () => {
  const inGroups = ['9000000001', '9000000002', '9000000004'];
  // Walked has a LID on file — the bot has messaged them before — and it is in neither group,
  // so their absence is PROVEN rather than merely unresolved.
  const { sock, sent } = sockWithGroups(inGroups, { '9000000003': '11112222333344@lid' });
  const notices = [];
  const members = [
    member('Stayed1', '9000000001', 0),
    member('Stayed2', '9000000002', 0),
    member('Walked', '9000000003', 0),
    member('Stayed3', '9000000004', 0),
  ];
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 4; i++) await engine.tick();

  const reached = sent.map(s => s.jid);
  assert.equal(sent.length, 3, 'the member who left was messaged anyway');
  assert.ok(!reached.includes('919000000003@s.whatsapp.net'), 'chased someone who walked out');
  for (const p of inGroups) assert.ok(reached.includes(`91${p}@s.whatsapp.net`), `${p} was wrongly skipped`);

  await engine.tick();   // queue empty → end of day
  const report = notices.at(-1);
  assert.match(report, /Left the groups — not messaged\* \(1\)/);
  assert.match(report, /Walked 9000000003/, 'the operator cannot act on a name they never see');
});

// The false "not in any group" the operator kept having to check by hand. In a LID-era group
// most participants arrive as an @lid with no phone attached, so a member who is sitting right
// there can be absent from the phone set. Absent-and-unidentifiable is not absent.
test('a member the roster cannot name is sent to, not reported as having left', async () => {
  const { sock, sent } = sockWithGroups(['9000000001', '9000000002']);   // no LID mapping at all
  const notices = [];
  const members = [
    member('Known', '9000000001', 0),
    member('Unnameable', '9000000003', 0),
  ];
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();   // one due member per tick — buildDripBatch takes one per cohort
  await engine.tick();

  assert.ok(sent.map(s => s.jid).includes('919000000003@s.whatsapp.net'),
    'a member the roster simply could not name was reported as having walked out');
  assert.deepEqual(notices.filter(n => n.includes('not in any group any more')), []);
});

// A roster that missed even ONE paid group is not slightly incomplete — it is completely wrong
// about everyone whose only group it was, and they are exactly who gets flagged.
test('a roster that could not read every paid group proves nothing', async () => {
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    signalRepository: { lidMapping: { getLIDForPN: async () => '55556666777788@lid' } },
    // Only the first group comes back, and the per-group fallback cannot read the second.
    async groupFetchAllParticipating() {
      return { [GROUPS[0]]: { id: GROUPS[0], participants: [{ id: '9000000001@s.whatsapp.net' }] } };
    },
    async groupMetadata() { throw new Error('not-authorized'); },
  };
  const notices = [];
  const members = [member('InTheOtherGroup', '9000000002', 0)];
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  assert.equal(sent.length, 1, 'a half-read roster silenced a member of the group it never read');
  assert.deepEqual(notices.filter(n => n.includes('not in any group any more')), []);
});

test('the roster is read once for the whole day, not once per send', async () => {
  const { sock, state } = sockWithGroups(['9000000001', '9000000002', '9000000003', '9000000004']);
  const members = [1, 2, 3, 4].map(n => member('M' + n, '900000000' + n, 0));
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 4; i++) await engine.tick();
  assert.equal(state.fetches, 1, `roster fetched ${state.fetches} times in one day`);
});

// The asymmetry that governs this whole feature: wrongly skipping a paying member costs real
// money and is silent — nobody complains about NOT being asked to pay. So every failure mode
// sends anyway.
test('an unreadable roster sends to everyone rather than muting the day', async () => {
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    async groupFetchAllParticipating() { throw new Error('rate limited'); },
  };
  const members = [1, 2, 3].map(n => member('M' + n, '900000000' + n, 0));
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 3; i++) await engine.tick();
  assert.equal(sent.length, 3, 'a failed roster fetch silenced the day');
});

// LID-era groups report participants that cannot be resolved to a phone at all. A roster that
// came back mostly LID would look like "almost everyone left" and mute the sheet.
test('a roster too small to be believed is ignored, not obeyed', async () => {
  const { sock, sent } = sockWithGroups(['9000000001']);   // 1 phone, 6 active members
  const members = [1, 2, 3, 4, 5, 6].map(n => member('M' + n, '900000000' + n, 0));
  const engine = createDripEngine(
    rosterCfg(tempBotDir()), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 6; i++) await engine.tick();
  assert.equal(sent.length, 6, 'a thin roster was trusted and muted five paying members');
});

// ── handing a batch to the operator ───────────────────────────────────────────
//
// The operator clearing an overflow with dmlist at noon and the bot reaching the same person
// at 4 PM is a double message — the exact thing this whole rework exists to prevent.

test('a batch the operator claims is not sent again the same day', async () => {
  const { sock, sent } = fakeSock();
  const members = [1, 2, 3].map(n => member('M' + n, '900000000' + n, 0));
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );

  engine.rememberShown(['9000000001', '9000000002']);
  const out = engine.markShownHandled();
  assert.match(out, /2 marked as sent by you today/);

  for (let i = 0; i < 3; i++) await engine.tick();
  assert.equal(sent.length, 1, 'the bot re-sent to someone the operator had already messaged');
  assert.equal(sent[0].jid, '919000000003@s.whatsapp.net');
});

// Looking must not silence. dmlist is also how the operator checks who is due, and a day-0
// member skipped today is a member who gets NOTHING until day 5 — days 1 to 4 match no cohort.
test('printing a list changes nothing until it is claimed', async () => {
  const { sock, sent } = fakeSock();
  const members = [1, 2].map(n => member('M' + n, '900000000' + n, 0));
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );

  engine.rememberShown(['9000000001', '9000000002']);
  for (let i = 0; i < 2; i++) await engine.tick();
  assert.equal(sent.length, 2, 'merely printing a list muted the bot');
});

test('claiming twice does not double-count, and claiming nothing says so', () => {
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => null, warmingUp: () => false },
  );
  assert.match(engine.markShownHandled(), /Nothing to mark/);

  engine.rememberShown(['9000000001']);
  assert.match(engine.markShownHandled(), /1 marked/);
  assert.match(engine.markShownHandled(), /Nothing to mark/, 'the same list was claimed twice');
});

// ── the queue count explains itself ────────────────────────────────────────────
import { describeQueue } from '../core/dripEngine.js';

test('one cohort reads as a bare number, several name themselves', () => {
  assert.equal(describeQueue({ due: 13, nudge: 0, final: 0, missed: 0 }), '13');
  assert.equal(describeQueue({ due: 0, nudge: 0, final: 0, missed: 0 }), '0');
  // The 25-08-2026 line that started this: 63 where the same day had said 14.
  assert.equal(
    describeQueue({ due: 13, nudge: 9, final: 5, missed: 36 }),
    '63 (13 due, 9 nudge, 5 final, 36 missed)',
  );
  // Empty cohorts are dropped rather than printed as zeroes.
  assert.equal(describeQueue({ due: 2, nudge: 0, final: 0, missed: 7 }), '9 (2 due, 7 missed)');
});

// ── A pushed link counts as contact, so 'missed' does not re-push it tomorrow ──
//
// Manual mode has no other delivery path: if the push does not record the cycle, the member
// stays in 'missed' for days 1-4 and the operator gets the same name back every morning.
test('a manual push records the cycle, so "missed" stops re-queueing that member', async () => {
  const calls = [];
  // 1 day overdue: past their date, before the day-5 nudge — squarely the 'missed' cohort.
  const m = member('A', '9000000001', 1);
  const store = { refresh: async () => {}, getAll: () => [m] };
  const engine = createDripEngine(engineCfg(), quietLog, store,
    { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });

  assert.equal(countRemaining({ members: [m], config: cfg, pushed: [], contactLog: {} }), 1,
    'they start out queued as missed');

  await engine.tick();
  assert.equal(calls.length, 1, 'the link went out');

  const logged = engine.contactLog()[String(m.phone)];
  assert.equal(logged?.cycle, m.billingDate, 'the billing cycle is on record');
  assert.equal(logged?.qr, undefined, 'no QR is claimed — the operator attaches that by hand');

  // Tomorrow: `pushed` has reset, so the cycle record is the only thing standing between
  // this member and a second identical link.
  assert.equal(
    countRemaining({ members: [m], config: cfg, pushed: [], contactLog: engine.contactLog() }),
    0, 'a member contacted this cycle is not re-queued as missed');
});

// ── Before the window is not after it ─────────────────────────────────────────
//
// The trap that nearly cost bot-nitin a whole day: arm cron at 6, window moved to 9.
test('a tick before the window opens waits, it does not end the day', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  // Window opens one hour from now — so "now" is always before it, whatever time the
  // suite runs at. At 23:xx that is hour 24, which no clock reaches: still "before".
  const openAt = new Date().getHours() + 1;
  const engine = createDripEngine({ ...cfg, botDir: tempBotDir(), drip: { startHour: openAt, endHour: 24 } },
    quietLog, store, { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });

  await engine.tick();
  assert.equal(calls.length, 0, 'nothing is pushed before the window opens');
  assert.ok(!engine.status().includes('finished'), `the day is not over: ${engine.status()}`);
  assert.equal(engine.contactLog()['9000000001'], undefined, 'and nobody was marked contacted');
});

test('a tick after the window closes still ends the day', async () => {
  const calls = [];
  const store = { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] };
  // Closes on the hour the suite is running in, so "now" is always past it.
  const engine = createDripEngine(
    { ...cfg, botDir: tempBotDir(), drip: { startHour: 0, endHour: new Date().getHours() } },
    quietLog, store, { autoRenewDue: async () => [] }, async (t) => { calls.push(t); });

  await engine.tick();
  assert.ok(engine.status().includes('finished'), `a closed window finishes: ${engine.status()}`);
});
