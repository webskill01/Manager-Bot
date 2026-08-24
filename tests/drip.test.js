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

// With max:1 the cohort ORDER decides who gets left out on a busy day. Day-6 members have
// one day left before the removal threshold; a due-today member missed now is simply a
// nudge tomorrow. Draining 'due' first would silently cost people their final notice.
test('the most overdue cohort is served first when only one send fits', () => {
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
  assert.deepEqual(order, ['msg3', 'msg2', 'msg1']);
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
      async sendPresenceUpdate(state, jid) { presence.push(state + ':' + jid); },
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
  // Typing before the message, stopped after — the cheapest human tell there is.
  assert.deepEqual(presence, [
    'sub:919000000001@s.whatsapp.net',
    'composing:919000000001@s.whatsapp.net',
    'paused:919000000001@s.whatsapp.net',
  ]);
  assert.ok(engine.status().includes('auto-send'));
});

test('one member per tick in auto mode, not the manual three', async () => {
  const { sock, sent } = fakeSock();
  const members = [member('A', '9000000001', 0), member('B', '9000000003', 5), member('C', '9000000005', 6)];
  const engine = createDripEngine(
    engineCfg({ drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();
  assert.equal(sent.length, 1);
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
  const many = Array.from({ length: 60 }, (_, i) => member('M' + i, '90000' + String(i).padStart(5, '0'), 0));
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
  assert.equal(busy.notices.length, 1, 'a 60-deep queue armed silently');
  assert.match(busy.notices[0], /60 reminders queued, room for about 3\d/);

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
test('five failures in a row stop the day and say why', async () => {
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

  assert.equal(notices.length, 1, 'the operator was not told');
  assert.match(notices[0], /Auto-send stopped/);
  assert.match(notices[0], /forbidden/, 'the actual error must reach the operator');
  assert.ok(engine.status().includes('stopped'));

  // And it stays stopped: a sixth tick must not quietly resume.
  const before = notices.length;
  await engine.tick();
  assert.equal(notices.length, before);
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
  assert.deepEqual(notices, [], 'alternating failures tripped the breaker');
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

// A QR marked sent on a message that threw would leave that member without one all cycle.
test('a failed send does not burn the member\'s QR', async () => {
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
  await engine.tick();
  fail = false;
  await engine.tick();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].msg.image, 'the retry went out without the QR');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the group-membership gate ─────────────────────────────────────────────────
//
// Someone who left the groups and is still chased for ₹90 is the most likely person in the
// whole sheet to press "report", and reports are what get numbers banned — not volume.

const GROUPS = ['120363000000000001@g.us', '120363000000000002@g.us'];

// A socket whose groups contain exactly `phones`. Counts roster reads so the "once a day"
// promise is actually checked rather than assumed.
function sockWithGroups(phones) {
  const sent = [];
  const state = { fetches: 0 };
  return {
    sent, state,
    sock: {
      user: { id: 'bot' },
      async presenceSubscribe() {}, async sendPresenceUpdate() {},
      async sendMessage(jid, msg) { sent.push({ jid, msg }); },
      async groupFetchAllParticipating() {
        state.fetches++;
        return Object.fromEntries(GROUPS.map((id, i) => [id, {
          id,
          // Split across the two groups, and throw in a LID-only participant: those cannot be
          // resolved to a phone and must simply not count either way.
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
  const { sock, sent } = sockWithGroups(inGroups);
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
