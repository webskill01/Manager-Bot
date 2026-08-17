import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReminderSender, renderSendLog } from '../core/reminderSender.js';
import { templateFor, isConfigured } from '../core/cloudApiSender.js';
import { formatDate } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

const today = () => formatDate(new Date());

function botDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
}

const baseConfig = (dir, extra = {}) => ({
  botName: 'bot-nitin',
  botDir: dir,
  profile: 'full',
  upiQrPath: '',
  renewal: { fullAmount: 90, referralAmount: 45, billingCycleDays: 30 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: {
    reminder: 'Sat Sri Akal {name}, {date} — pay 90',
    referralReminder: 'Sat Sri Akal {name}, {date} — pay 45',
    overdue: 'o', finalReminder: 'f',
  },
  // Deliberately group mode: bot-nitin's real setting. The Cloud API must outrank it.
  reminder: { mode: 'group', groupId: 'g1@g.us' },
  rateLimits: {
    memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0,
    dmReminderGapMinMs: 0, dmReminderGapMaxMs: 0,
    batchSize: 20, circuitBreakerThreshold: 10, circuitBreakerCooldownMs: 1000,
  },
  ...extra,
});

const cloudOn = (dir, extra = {}) => baseConfig(dir, {
  reminderChannel: 'cloudapi',
  cloudApi: {
    phoneNumberId: '123', token: 'TOKEN', languageCode: 'en',
    templates: { reminder: 'renewal_due', referralReminder: 'renewal_due_referral', overdue: 'renewal_overdue', finalReminder: 'renewal_final' },
    ...extra,
  },
});

function makeStore(members) {
  const rows = members.map(m => ({ ...m }));
  return {
    rows,
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    async refresh() {},
    async update(phone, u) { Object.assign(rows.find(m => m.phone === phone), u); return null; },
    async updateMany() { return { updated: 0, missing: [] }; },
  };
}

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    impl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { ok: next.status < 300, status: next.status, json: async () => next.body };
    },
  };
}

const okResponse = (id = 'wamid.TEST') => ({ status: 200, body: { messages: [{ id }] } });

// ── template selection ────────────────────────────────────────────────────────

test('per-stage template names resolve, with templateName as the fallback', () => {
  const cfg = { cloudApi: { templates: { reminder: 'a', finalReminder: 'b' }, templateName: 'legacy' } };
  assert.equal(templateFor(cfg, 'reminder'), 'a');
  assert.equal(templateFor(cfg, 'finalReminder'), 'b');
  assert.equal(templateFor(cfg, 'overdue'), 'legacy', 'an unset stage must fall back, not send null');
  assert.equal(templateFor({ cloudApi: { templateName: 'only' } }, 'reminder'), 'only',
    'an existing single-template setup must keep working');
  assert.equal(templateFor({ cloudApi: {} }, 'reminder'), null);
});

test('a templates object with nothing usable in it is NOT configured', () => {
  assert.equal(isConfigured({ cloudApi: { phoneNumberId: '1', token: 't', templates: {} } }), false,
    'would send template name null and burn a 132001 per member');
  assert.equal(isConfigured({ cloudApi: { phoneNumberId: '1', token: 't', templates: { reminder: 'x' } } }), true);
  assert.equal(isConfigured({ cloudApi: { phoneNumberId: '1', token: 't', templateName: 'x' } }), true);
});

// ── the routing that matters ──────────────────────────────────────────────────

test('a due-today reminder goes out over the Cloud API and NEVER touches the socket', async () => {
  // The whole point: after a 403 the socket is dead, and reminders must still leave. A
  // getSock that throws is the only honest way to assert the path never reaches for it.
  const dir = botDir();
  const f = fakeFetch([okResponse('wamid.ABC')]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  const explode = () => { throw new Error('the socket was touched — a banned number would break reminders'); };

  const res = await sender.sendToMember(explode, '9855112233', 'Gurpreet', dir, 'normal', today());

  assert.equal(res.ok, true, `send failed: ${res.error}`);
  assert.equal(res.messageId, 'wamid.ABC', 'the wamid is the only receipt there is — it must come back');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /123\/messages/);
  assert.equal(f.calls[0].body.template.name, 'renewal_due');
  assert.equal(f.calls[0].body.to, '919855112233', 'Cloud API needs a bare international number');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 1-referral member gets the ₹45 template, not the ₹90 one', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse()]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  await sender.sendToMember(() => null, '9855112233', 'Jaspal', dir, 'referral', today());
  assert.equal(f.calls[0].body.template.name, 'renewal_due_referral');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the member\'s own billing date is sent as the {{2}} param, not today', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse()]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  await sender.sendToMember(() => null, '9855112233', 'Balwinder', dir, 'normal', '05-03-2026');
  const params = f.calls[0].body.template.components.find(c => c.type === 'body').parameters;
  assert.equal(params[0].text, 'Balwinder');
  assert.equal(params[1].text, '5 Mar', 'the member sees their OWN renewal date, not today');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('group mode is overridden by the Cloud API — no group digest, private DMs instead', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse()]);
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
  ]);
  const groupSends = [];
  const sock = { user: { id: 'bot' }, async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, m) { groupSends.push({ jid, m }); } };

  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  const result = await sender.sendReminders(store, () => sock, dir);

  assert.equal(groupSends.filter(s => s.jid === 'g1@g.us').length, 0,
    'posted a group digest — the last proactive Baileys traffic was supposed to stop');
  assert.equal(result.sent, 1, `expected one private API send, got ${JSON.stringify(result)}`);
  assert.equal(f.calls.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('with the API off, group mode still works exactly as before', async () => {
  const dir = botDir();
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
  ]);
  const groupSends = [];
  const sock = { user: { id: 'bot' }, async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, m) { groupSends.push({ jid, m }); } };

  const sender = createReminderSender(baseConfig(dir), log);
  await sender.sendReminders(store, () => sock, dir);
  assert.ok(groupSends.some(s => s.jid === 'g1@g.us'), 'group mode regressed for a non-API bot');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the send log: the answer to "how do I know it went out?" ───────────────────

test('every send is recorded with its message id, per member, as it happens', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse('wamid.ONE'), okResponse('wamid.TWO')]);
  const store = makeStore([
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
    { name: 'Jaspal', phone: '9000000002', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
  ]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  await sender.sendReminders(store, () => null, dir);

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'reminder-state.json'), 'utf8'));
  assert.equal(state.sends.length, 2, `send log did not record both: ${JSON.stringify(state.sends)}`);
  assert.deepEqual(state.sends.map(s => s.messageId), ['wamid.ONE', 'wamid.TWO']);
  assert.deepEqual(state.sends.map(s => s.name), ['Gurpreet', 'Jaspal']);
  assert.ok(state.sends[0].at, 'no timestamp — the record has to say when');

  const rendered = renderSendLog(dir);
  assert.match(rendered, /2 sent, 0 failed/);
  assert.match(rendered, /wamid\.ONE/, 'the operator cannot see the receipt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rejection is recorded with Meta\'s reason and code, and never marked sent', async () => {
  const dir = botDir();
  const f = fakeFetch([{ status: 400, body: { error: { message: 'Recipient not on WhatsApp', code: 131026 } } }]);
  const store = makeStore([
    { name: 'Balwinder', phone: '9000000003', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
  ]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  const result = await sender.sendReminders(store, () => null, dir);

  assert.equal(result.failed, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'reminder-state.json'), 'utf8'));
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].code, 131026, "Meta's code is what says whether YOU need to act");
  assert.ok(!state.sentPhones.includes('9000000003'),
    'a failed member was marked sent — they would silently never be reminded today');

  const rendered = renderSendLog(dir);
  assert.match(rendered, /0 sent, 1 failed/);
  assert.match(rendered, /131026/);
  assert.match(rendered, /dmlist/, 'a failure report must say how to recover');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a crash mid-batch leaves an accurate record of who was already messaged', async () => {
  // Persistence is per member, not per batch: on restart the second batch must not re-send
  // to whoever already got one, because each resend is another charged message.
  const dir = botDir();
  const f = fakeFetch([okResponse('wamid.FIRST')]);
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today(), renewals: 1, paidLast: 90 },
  ]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  await sender.sendReminders(store, () => null, dir);

  // Fresh sender, same dir — models the restart.
  const f2 = fakeFetch([okResponse('wamid.SHOULD_NOT_HAPPEN')]);
  const sender2 = createReminderSender(cloudOn(dir), log, { fetchImpl: f2.impl });
  const again = await sender2.sendRemindersSecondBatch(store, () => null, dir);

  assert.equal(f2.calls.length, 0, 'the same member was messaged twice across a restart');
  assert.equal(again.sent, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the log tells the truth when nothing has been sent yet', () => {
  const dir = botDir();
  const rendered = renderSendLog(dir);
  assert.match(rendered, /No reminders sent yet today/);
  assert.match(rendered, /due/, 'should point at how to check whether there was anything to send');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ten straight API rejections trip the circuit breaker', async () => {
  // A dead token fails for everyone. Burning through 22 members to discover that is 22
  // pointless calls, and the failure report is more useful than the 12th identical error.
  const dir = botDir();
  const f = fakeFetch([{ status: 401, body: { error: { message: 'token expired', code: 190 } } }]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });
  for (let i = 0; i < 10; i++) {
    await sender.sendToMember(() => null, `900000000${i}`, `M${i}`, dir, 'normal', today());
  }
  const after = await sender.sendToMember(() => null, '9111111111', 'Late', dir, 'normal', today());
  assert.equal(after.ok, false);
  assert.match(after.error, /circuit/i, `breaker did not open: ${after.error}`);
  assert.equal(f.calls.length, 10, 'kept calling Meta after ten straight failures');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the two-variable contract ─────────────────────────────────────────────────
// Every template takes exactly {{1}} name and {{2}} a date. Meta rejects any param-count
// mismatch with 132000, and the real count lives in an approved template on Meta's side
// that the code cannot inspect — so the only version that can't silently rot is one shape
// everywhere. This caught renewal_final being sent 3 params against a 0-variable body.
test('every reminder stage sends exactly two body params: name then a date', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse()]);
  const sender = createReminderSender(cloudOn(dir), log, { fetchImpl: f.impl });

  for (const type of ['normal', 'referral']) {
    f.calls.length = 0;
    await sender.sendToMember(() => null, '9855112233', 'Gurpreet', dir, type, '05-03-2026');
    const params = f.calls[0].body.template.components.find(c => c.type === 'body').parameters;
    assert.equal(params.length, 2, `${type} sent ${params.length} params, template expects 2`);
    assert.equal(params[0].text, 'Gurpreet');
    assert.match(params[1].text, /^\d{1,2} \w{3}$/, `param 2 must be a date, got "${params[1].text}"`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the overdue and final stages send two params too, not three', async () => {
  const dir = botDir();
  const f = fakeFetch([okResponse()]);
  const store = makeStore([
    // 6 days overdue = the final-reminder milestone for this config.
    { name: 'Balwinder', phone: '9000000009', status: 'ACTIVE', renewals: 1, paidLast: 90,
      billingDate: formatDate(new Date(Date.now() - 6 * 864e5)) },
  ]);
  const { createOverdueEngine } = await import('../core/overdueEngine.js');
  const cfg = { ...cloudOn(dir), paidGroups: ['g1@g.us'] };
  globalThis.fetch = f.impl;
  try {
    const engine = createOverdueEngine(cfg, log);
    await engine.runOverdueCheck(store, () => ({ user: { id: 'bot' }, async groupMetadata() { return { participants: [] }; }, async sendMessage() {} }), []);
  } finally {
    delete globalThis.fetch;
  }
  assert.ok(f.calls.length > 0, 'the overdue engine sent nothing through the API');
  for (const call of f.calls) {
    const params = call.body.template.components.find(c => c.type === 'body').parameters;
    assert.equal(params.length, 2,
      `${call.body.template.name} sent ${params.length} params — Meta answers 132000 for a mismatch`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
