import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDripEngine, buildDripQueue, planTimes, dripSettings } from '../core/dripEngine.js';
import { formatDate, todayStr } from '../core/globalConfig.js';

const quietLog = { info() {}, warn() {}, error() {} };

function makeConfig(extra = {}) {
  return {
    joining: { fee: 90 },
    renewal: { fullAmount: 90, referralAmount: 45 },
    overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
    messages: { reminder: 'due {name} {date}', overdue: 'late {name}', finalReminder: 'final {name}' },
    ...extra,
  };
}

// Billing dates are computed off the REAL today — daysFromToday has no injectable clock —
// so a hardcoded date would make these pass on one day of the year only.
function member(name, phone, overdueDays, extra = {}) {
  const d = new Date();
  d.setDate(d.getDate() - overdueDays);
  return {
    name, phone, status: 'ACTIVE', renewals: 0, paidLast: 0,
    billingDate: formatDate(d), joinDate: formatDate(d), lastRenewed: '', lastUpdated: '',
    ...extra,
  };
}
// ── drip plan ──────────────────────────────────────────────────────────────────

test('the queue is every cohort in send order — due, then nudge, then final', () => {
  const members = [
    member('FinalA', '9000000005', 6),
    member('DueA', '9000000001', 0),
    member('NudgeA', '9000000003', 5),
    member('DueB', '9000000002', 0),
  ];
  const q = buildDripQueue({ members, config: makeConfig() });
  assert.deepEqual(q.map(r => r.stage), ['msg1', 'msg1', 'msg2', 'msg3']);
});

test('the queue drops whoever has already been handled today', () => {
  const members = [member('DueA', '9000000001', 0), member('DueB', '9000000002', 0)];
  const q = buildDripQueue({ members, config: makeConfig(), pushed: ['9000000001'] });
  assert.deepEqual(q.map(r => r.phone), ['9000000002']);
});

test('planned times run forward and stay inside the window', () => {
  const settings = dripSettings({ drip: { mode: 'auto', startHour: 6, endHour: 18, gapMinMs: 60000 } });
  const from = new Date('2026-08-25T06:00:00');
  const queue = Array.from({ length: 8 }, (_, i) => ({ name: `M${i}`, phone: `900000000${i}` }));
  const rows = planTimes(queue, settings, { from });

  assert.equal(rows.length, 8);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].at > rows[i - 1].at, 'the plan went backwards in time');
  }
  assert.ok(rows.every(r => !r.late), '8 members did not fit a 12-hour window');
});

// The overflow is the number the operator needs at 6 AM, not at 9 PM.
test('a queue too long for the window is flagged as spilling over', () => {
  const settings = dripSettings({ drip: { mode: 'auto', startHour: 6, endHour: 18, gapMinMs: 3600000 } });
  const from = new Date('2026-08-25T06:00:00');
  const queue = Array.from({ length: 40 }, (_, i) => ({ name: `M${i}`, phone: `90000000${i}` }));
  const rows = planTimes(queue, settings, { from });
  assert.ok(rows.some(r => r.late), 'a 40-deep queue at a 1h floor reported as fitting in 12 hours');
});

test('drip plan lists the day in order and marks who carries the QR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const members = [
    member('FinalGuy', '9000000005', 6),
    member('DueGuy', '9000000001', 0),
  ];
  const engine = createDripEngine(
    makeConfig({ botDir: dir, upiQrPath: ['./qr-1.jpg'],
      drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => ({ user: { id: 'b' } }), warmingUp: () => false },
  );
  const out = await engine.plan();

  assert.ok(out.indexOf('DueGuy') < out.indexOf('FinalGuy'), 'the plan is not in send order');
  // The count carries its cohort split — a long plan is a backlog, not a runaway.
  assert.match(out, /2 \(1 due, 1 final\) to go/);
  // 📷 marks the QR. DueGuy is msg1 so carries it; FinalGuy has had no contact this cycle,
  // so they carry one too — that is the "chased with no way to pay" hole staying shut.
  // Counted in the row body only; the header carries one as a legend.
  const body = out.slice(out.lastIndexOf('━') + 1);
  assert.equal((body.match(/📷/g) || []).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Reading the plan must never silence anyone — that is what `dmlist done` is for.
test('drip plan records nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const members = [member('DueGuy', '9000000001', 0)];
  const engine = createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => ({ user: { id: 'b' } }), warmingUp: () => false },
  );
  await engine.plan();
  await engine.plan();
  assert.match(engine.status(), /0 sent by the bot/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── surviving a restart ────────────────────────────────────────────────────────

const dripCfg = (dir, extra = {}) => makeConfig({
  botDir: dir,
  drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false, ...extra },
});

const liveSock = () => ({
  user: { id: 'b' },
  async presenceSubscribe() {}, async sendPresenceUpdate() {}, async sendMessage() {},
});

function dripFor(dir, members, log = quietLog) {
  return createDripEngine(
    dripCfg(dir), log, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => liveSock(), warmingUp: () => false },
  );
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// index.js calls resume() on every connection 'open', and a socket reconnect is
// indistinguishable from a process restart from inside the engine. Redrawing the gap each
// time pushed the next member back by up to a full gap per reconnect — and bot-nitin took
// seven reconnects in one four-hour stretch.
test('a socket reconnect does not push back the send already scheduled', async () => {
  const dir = tmp('resume-');
  const log = [];
  const engine = dripFor(dir, [member('A', '9000000001', 0)],
    { info: (m) => log.push(m), warn() {}, error() {} });
  await engine.arm();
  log.length = 0;
  for (let i = 0; i < 3; i++) engine.resume();
  assert.deepEqual(log, [], 'a reconnect redrew the pending gap');
  fs.rmSync(dir, { recursive: true, force: true });
});

// node-cron does not replay a firing the process was not alive for, so this used to lose the
// entire day while `status` still said "running".
test('a bot that was down at arm time arms itself on the way back up', async () => {
  const dir = tmp('resume-');
  fs.writeFileSync(path.join(dir, 'drip-state.json'), JSON.stringify(
    { date: todayStr(), pushed: [], stopped: false, done: false, armedAt: null }));
  const log = [];
  const engine = dripFor(dir, [member('A', '9000000001', 0)],
    { info: (m) => log.push(m), warn() {}, error() {} });
  engine.resume();
  assert.ok(log.some(l => l.includes('Missed the arm cron')), 'the day was silently lost');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resume never restarts a day that was stopped or already finished', async () => {
  for (const flag of ['stopped', 'done']) {
    const dir = tmp('resume-');
    fs.writeFileSync(path.join(dir, 'drip-state.json'), JSON.stringify(
      { date: todayStr(), pushed: [], stopped: false, done: false, armedAt: null, [flag]: true }));
    const log = [];
    const engine = dripFor(dir, [member('A', '9000000001', 0)],
      { info: (m) => log.push(m), warn() {}, error() {} });
    log.length = 0;   // drop the "Drip AUTO" banner the constructor emits
    engine.resume();
    assert.deepEqual(log, [], `resume re-armed a ${flag} day`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The one on-disk format this change touches. Pulling mid-day must not hand a second QR to
// everyone who already got one this morning.
test('an old flat qr-sent.json is read, not ignored — no second QR after an upgrade', async () => {
  const dir = tmp('qrmig-');
  fs.writeFileSync(path.join(dir, 'qr-1.jpg'), 'qr');
  const m = member('A', '9000000001', 5);
  // The pre-upgrade shape: phone → the billingDate the QR went out in.
  fs.writeFileSync(path.join(dir, 'qr-sent.json'), JSON.stringify({ '9000000001': m.billingDate }));

  const sent = [];
  const sock = {
    user: { id: 'b' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async sendMessage(jid, msg) { sent.push(msg); },
  };
  const engine = createDripEngine(
    makeConfig({ botDir: dir, upiQrPath: ['./qr-1.jpg'],
      drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [m] },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].image, 'the upgrade re-sent a QR the member already had');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── addressing: the bug that logged nine sends and delivered five ──────────────

// A fake socket that records the JID it was actually asked to send to, and answers
// onWhatsApp from a lookup table.
function addressableSock(lookup) {
  const sent = [];
  return {
    sent,
    sock: {
      user: { id: 'bot' },
      async presenceSubscribe() {}, async sendPresenceUpdate() {},
      async onWhatsApp(pn) {
        const answer = lookup[pn];
        if (answer === 'throw') throw new Error('usync timed out');
        if (!answer) return [{ exists: false }];
        return [{ exists: true, jid: answer }];
      },
      async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    },
  };
}

function autoEngine(dir, members, sock, log = quietLog) {
  return createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    log, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => false },
  );
}

// The whole point. A LID-primary account accepts a send to its phone JID and never shows
// the message, and sendMessage does not throw — so the bot logged a success it never had.
test('the send goes to the JID WhatsApp names, not the one we assembled', async () => {
  const dir = tmp('addr-');
  const { sock, sent } = addressableSock({ '919000000001': '242902009692413@lid' });
  await autoEngine(dir, [member('A', '9000000001', 0)], sock).tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '242902009692413@lid', 'sent to the guessed phone JID again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a number WhatsApp does not know is reported, never silently counted as sent', async () => {
  const dir = tmp('addr-');
  const notices = [];
  const { sock, sent } = addressableSock({});          // nobody exists
  const engine = createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('Ghost', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  assert.equal(sent.length, 0, 'it sent to a number that does not exist');
  assert.ok(notices.some(n => n.includes('Not on WhatsApp') && n.includes('Ghost')),
    'the operator was never told the number is dead');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fails OPEN, exactly like the roster check: wrongly skipping someone who pays is invisible
// and costs money, so only an explicit "does not exist" may stop a send.
test('a lookup that errors still sends, to the phone JID', async () => {
  const dir = tmp('addr-');
  const { sock, sent } = addressableSock({ '919000000001': 'throw' });
  await autoEngine(dir, [member('A', '9000000001', 0)], sock).tick();

  assert.equal(sent.length, 1, 'a usync hiccup cost a paying member their reminder');
  assert.equal(sent[0].jid, '919000000001@s.whatsapp.net');
  fs.rmSync(dir, { recursive: true, force: true });
});

// One bad row must not eat the day by retrying every five minutes.
test('an unreachable member is passed over and the queue keeps moving', async () => {
  const dir = tmp('addr-');
  const { sock, sent } = addressableSock({ '919000000002': '919000000002@s.whatsapp.net' });
  const members = [member('Ghost', '9000000001', 0), member('Real', '9000000002', 0)];
  await autoEngine(dir, members, sock).tick();

  assert.equal(sent.length, 1);
  assert.ok(sent[0].msg.text.includes('Real'), 'the queue stalled on the dead number');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── telling the operator, not the log file ────────────────────────────────────

test('a member who left the groups is pushed to Telegram when it happens', async () => {
  const dir = tmp('notify-');
  const notices = [];
  const { sock } = addressableSock({ '919000000001': '919000000001@s.whatsapp.net' });
  // A roster that resolves plenty of phones but not this member's.
  sock.groupFetchAllParticipating = async () => ({
    g1: { id: 'g1@g.us', participants: [{ phoneNumber: '919999999999@s.whatsapp.net' }] },
  });
  const engine = createDripEngine(
    makeConfig({ botDir: dir, paidGroups: ['g1@g.us'],
      drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('Vivek', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();

  assert.ok(notices.some(n => n.includes('Vivek') && n.includes('not in any group')),
    'the operator only found out from the log');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dead number is pushed to Telegram, not just written to the log', async () => {
  const dir = tmp('notify-');
  const notices = [];
  const { sock } = addressableSock({});
  const engine = createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('Ghost', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  await engine.tick();
  assert.ok(notices.some(n => n.includes('Ghost') && n.includes('not on WhatsApp')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// retrySoon() comes back to the SAME member every five minutes. One buzz per member is
// signal; one per attempt is what makes an operator mute the bot.
test('a failing member is handed over once, not once per retry', async () => {
  const dir = tmp('notify-');
  const notices = [];
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async onWhatsApp(pn) { return [{ exists: true, jid: `${pn}@s.whatsapp.net` }]; },
    async sendMessage() { throw new Error('server said no'); },
  };
  const engine = createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [member('A', '9000000001', 0)] },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false },
  );
  for (let i = 0; i < 4; i++) await engine.tick();

  const handoffs = notices.filter(n => n.includes('Send it yourself'));
  assert.equal(handoffs.length, 1, `four ticks produced ${handoffs.length} handoffs`);
  assert.ok(handoffs[0].includes('server said no'), 'the real error must reach the operator');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── "can it send right now?" ───────────────────────────────────────────────────
// On 25-08-2026 the bot was disconnected for most of the day and `drip` reported
// "running" the whole time. The state file cannot know: linkOnly is only set once a send has
// already been rejected. Status asks the socket instead.
test('status says so when the socket is down, and not when it is up', () => {
  const dir = tmp('drip-live-');
  const build = (sock, warm) => createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => [] },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => sock, warmingUp: () => warm },
  );

  assert.match(build(null, false).status(), /DISCONNECTED/);
  assert.match(build({}, false).status(), /DISCONNECTED/);          // socket object, never linked
  assert.match(build({ user: { id: 'b' } }, true).status(), /Warm-up/);
  const ok = build({ user: { id: 'b' } }, false).status();
  assert.doesNotMatch(ok, /DISCONNECTED|Warm-up/);
  assert.match(ok, /auto-send/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the 'missed' cohort in the queue ───────────────────────────────────────────

test('the queue works due first, then the chase-ups, then the missed backlog', () => {
  const members = [
    member('FinalGuy', '9000000006', 6),
    member('NudgeGuy', '9000000005', 5),
    member('MissedGuy', '9000000002', 2),
    member('DueGuy', '9000000000', 0),
  ];
  const q = buildDripQueue({ members, config: makeConfig() });
  // A day-6 member loses their last notice forever if the backlog jumps ahead of them.
  assert.deepEqual(q.map(r => r.name), ['DueGuy', 'NudgeGuy', 'FinalGuy', 'MissedGuy']);
});

test('a member reached this cycle is not queued again as missed', () => {
  const m = member('MissedGuy', '9000000002', 2);
  const q = buildDripQueue({
    members: [m], config: makeConfig(),
    contactLog: { '9000000002': { cycle: m.billingDate } },
  });
  assert.deepEqual(q, []);
});

// `dmlist done` is the operator asserting they sent that batch. Without recording it against
// the CYCLE (state.pushed resets at midnight) their own hand-sent batch comes back at them
// as missed tomorrow.
test('dmlist done records the contact for the cycle, not just for today', () => {
  const dir = tmp('drip-done-');
  const members = [member('A', '9000000001', 2), member('B', '9000000002', 2)];
  const engine = createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async () => {},
    { getSock: () => ({ user: { id: 'b' } }), warmingUp: () => false },
  );

  engine.rememberShown(['9000000001']);
  engine.markShownHandled();

  const logged = JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'));
  assert.equal(logged['9000000001'].cycle, members[0].billingDate);
  assert.equal(logged['9000000001'].qr, undefined, 'dmlist done cannot know whether a QR was attached');
  assert.equal(logged['9000000002'], undefined, 'only the batch that was claimed');

  // Tomorrow's queue (pushed has reset) must not offer A back.
  const q = buildDripQueue({ members, config: makeConfig(), contactLog: logged });
  assert.deepEqual(q.map(r => r.name), ['B']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── a restart must not eat the delivery check ──────────────────────────────────
// 25-08-2026: Vikramjeet was sent a reminder at 17:38, the process restarted at 17:43, and
// the next tick had nothing to check. No delivery, no report, no handoff, and no ping to say
// so — the member was simply marked done and forgotten. `lastSend` lived in memory only.

function stagedRestart(dir, { pid, phone = '9000000001' } = {}) {
  const m = member('Vikram', phone, 0);
  const row = {
    name: m.name, phone, billingDate: m.billingDate, overdueDays: 0,
    stage: 'msg1', fee: 90, text: 'due', link: `https://wa.me/91${phone}?text=due`,
  };
  fs.writeFileSync(path.join(dir, 'drip-state.json'), JSON.stringify({
    date: todayStr(), pushed: [phone], stopped: false, done: false, armedAt: Date.now(),
    lastSend: { id: 'MSGID', name: m.name, phone, at: Date.now(), row, pid },
  }));
  // noteSent already claimed the cycle at send time — that is the record under test.
  fs.writeFileSync(path.join(dir, 'qr-sent.json'),
    JSON.stringify({ [phone]: { cycle: m.billingDate, qr: m.billingDate } }));
  return { m, row };
}

function engineOver(dir, members, notices, verdict) {
  return createDripEngine(
    makeConfig({ botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false } }),
    quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => ({ user: { id: 'b' } }), warmingUp: () => false, tracker: { verdict: () => verdict } },
  );
}

// The message went out; only the ANSWER was lost with the process. Reported, never handed
// back — asking the operator to re-send a message that almost certainly landed is how the
// handoff ping stopped meaning anything.
test('a send the previous process made is reported as unknown, not asked to be re-sent', async () => {
  const dir = tmp('drip-restart-');
  const { m } = stagedRestart(dir, { pid: process.pid + 1 });
  const notices = [];
  // The tracker would say "never acknowledged" for an id it has never seen. That verdict
  // must not be used: this process cannot know, and saying so is the whole point.
  await engineOver(dir, [m], notices, { ok: false, hard: true, fatal: false, why: 'never acknowledged' }).tick();

  assert.deepEqual(notices.filter(n => n.includes('Send it yourself')), [],
    'a message that had already gone out was handed back to be sent again');

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.equal(state.lastSend, null, 'the check must not run twice');
  assert.match(state.undelivered.join(''), /Vikram/);
  assert.match(state.undelivered.join(''), /restarted before it could check/);
  assert.doesNotMatch(state.undelivered.join(''), /never acknowledged/, 'a guess was reported as a fact');
  // ...and the cycle record stands, so 'missed' does not queue a duplicate for them either.
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'))['9000000001']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A receipt that arrives AFTER the reconnect lands in the new process's tracker like any
// other. Asking it before falling back to "unknown" is free, and it turns a restart inside
// the gap from a permanent question mark into an ordinary delivered message.
test('a receipt that arrives after the restart still proves delivery', async () => {
  const dir = tmp('drip-restart-ok-');
  const { m } = stagedRestart(dir, { pid: process.pid + 1 });
  const notices = [];
  await engineOver(dir, [m], notices, { ok: true, status: 3 }).tick();

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.equal((state.undelivered || []).length, 0, 'a delivered message was reported as unknown');
  assert.deepEqual(notices.filter(n => n.includes('Send it yourself')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a send that never left stops counting as contact, so missed can recover them', async () => {
  const dir = tmp('drip-forget-');
  const { m } = stagedRestart(dir, { pid: process.pid });
  await engineOver(dir, [m], [], { ok: false, hard: true, fatal: false, why: 'x' }).tick();

  const qr = JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'));
  assert.equal(qr['9000000001'], undefined, 'the cycle record still claims they were reached');
  // Tomorrow they are 1d overdue with no contact on file — exactly the missed cohort.
  const tomorrow = member('Vikram', '9000000001', 1);
  assert.deepEqual(buildDripQueue({ members: [tomorrow], config: makeConfig(), contactLog: qr })
    .map(r => r.name), ['Vikram']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The one verdict that still earns a buzz: the message provably never left the bot, so the
// member really is owed one and the operator's thumb is the only thing that can deliver it.
test('a message that never left is handed over, and releases the cycle record', async () => {
  const dir = tmp('drip-failed-');
  const { m } = stagedRestart(dir, { pid: process.pid });
  const notices = [];
  await engineOver(dir, [m], notices,
    { ok: false, hard: true, fatal: false, why: 'never acknowledged — it did not leave the bot' }).tick();

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'))['9000000001'], undefined);
  assert.match(notices.find(n => n.includes('Send it yourself')), /did not leave the bot/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a delivered send keeps its cycle record and says nothing', async () => {
  const dir = tmp('drip-ok-');
  const { m } = stagedRestart(dir, { pid: process.pid });
  const notices = [];
  await engineOver(dir, [m], notices, { ok: true, status: 3 }).tick();

  const qr = JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'));
  assert.equal(qr['9000000001'].cycle, m.billingDate, 'a delivered reminder was forgotten');
  assert.equal(notices.filter(n => n.includes('Send it yourself')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
