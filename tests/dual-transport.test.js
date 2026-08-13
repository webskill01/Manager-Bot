import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramListener } from '../core/telegramTransport.js';
import { createCommandParser } from '../core/commandParser.js';

const log = { info() {}, warn() {}, error() {} };

// ── a fake Telegram API ───────────────────────────────────────────────────────
// Serves one batch of updates, then empties out and stops the listener, so poll()
// terminates instead of spinning. Records every outbound sendMessage.
function fakeTelegram(updates = []) {
  const sent = [];
  let served = false;
  const api = {
    sent,
    listener: null,
    impl: async (url, opts) => {
      const method = url.split('/').pop();
      const body = JSON.parse(opts.body);
      if (method === 'getMe') {
        return { json: async () => ({ ok: true, result: { id: 1, username: 'nitin_manager_bot' } }) };
      }
      if (method === 'sendMessage') {
        sent.push({ chatId: body.chat_id, text: body.text });
        return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
      }
      if (method === 'getUpdates') {
        if (served) { api.listener?.stop(); return { json: async () => ({ ok: true, result: [] }) }; }
        served = true;
        return { json: async () => ({ ok: true, result: updates }) };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return api;
}

const update = (id, fromId, text) => ({
  update_id: id,
  message: { from: { id: fromId, first_name: 'Nitin' }, chat: { id: fromId }, text },
});

function listenerOn(api, opts = {}) {
  const seen = [];
  const listener = createTelegramListener({
    token: '123:FAKE',
    botName: 'bot-nitin',
    log,
    fetchImpl: api.impl,
    onCommand: async (text, reply) => { seen.push(text); await reply(`ok: ${text}`); },
    ...opts,
  });
  api.listener = listener;
  return { listener, seen };
}

test('an authorized operator reaches onCommand and gets the reply back', async () => {
  const api = fakeTelegram([update(1, 777, 'summary')]);
  const { listener, seen } = listenerOn(api, { allowedIds: [777] });
  await listener.start();
  assert.deepEqual(seen, ['summary']);
  assert.deepEqual(api.sent, [{ chatId: 777, text: 'ok: summary' }]);
});

test('an unknown sender runs nothing and is answered with silence', async () => {
  const api = fakeTelegram([update(1, 666, 'kick 9855112233')]);
  const { listener, seen } = listenerOn(api, { allowedIds: [777] });
  await listener.start();
  assert.deepEqual(seen, [], 'a stranger got a command executed');
  assert.deepEqual(api.sent, [], 'replying at all confirms the bot exists to a stranger');
});

test('bootstrap mode hands back the sender id and still runs no commands', async () => {
  const api = fakeTelegram([update(1, 555, 'add Raju 9855112233')]);
  const { listener, seen } = listenerOn(api, { allowedIds: [], bootstrapMode: true });
  await listener.start();
  assert.deepEqual(seen, [], 'bootstrap mode must not execute commands');
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /555/, 'the operator was not told their own id');
});

test('a reply longer than one Telegram message is split, never dropped', async () => {
  const api = fakeTelegram([update(1, 777, 'log')]);
  const listener = createTelegramListener({
    token: '123:FAKE', botName: 'bot-nitin', log, allowedIds: [777], fetchImpl: api.impl,
    onCommand: async (_text, reply) => reply('x'.repeat(9000)),
  });
  api.listener = listener;
  await listener.start();
  assert.equal(api.sent.length, 3, `9000 chars should split into 3 messages, got ${api.sent.length}`);
  assert.equal(api.sent.map(s => s.text).join('').length, 9000, 'characters were lost in chunking');
});

test('an array reply is sent as ordered parts, behind the slow-command ack', async () => {
  // dmlist is in SLOW_COMMANDS, so an instant receipt precedes the real output — that is
  // how the operator knows a sheet-writing command landed during a slow run.
  const api = fakeTelegram([update(1, 777, 'dmlist')]);
  const listener = createTelegramListener({
    token: '123:FAKE', botName: 'bot-nitin', log, allowedIds: [777], fetchImpl: api.impl,
    onCommand: async (_text, reply) => reply(['part one', 'part two']),
  });
  api.listener = listener;
  await listener.start();
  assert.match(api.sent[0].text, /Got it/, 'no receipt for a slow command');
  assert.deepEqual(api.sent.slice(1).map(s => s.text), ['part one', 'part two']);
});

test('a quick lookup gets no ack — just the answer', async () => {
  const api = fakeTelegram([update(1, 777, 'summary')]);
  const { listener } = listenerOn(api, { allowedIds: [777] });
  await listener.start();
  assert.equal(api.sent.length, 1, `quick commands must not be double-messaged: ${JSON.stringify(api.sent)}`);
});

test('the offset advances past a command that throws, so it is never replayed', async () => {
  // A half-finished sheet write must not be re-run on the next poll.
  const api = fakeTelegram([update(41, 777, 'boom'), update(42, 777, 'summary')]);
  const seen = [];
  const listener = createTelegramListener({
    token: '123:FAKE', botName: 'bot-nitin', log, allowedIds: [777], fetchImpl: api.impl,
    onCommand: async (text) => { seen.push(text); if (text === 'boom') throw new Error('handler blew up'); },
  });
  api.listener = listener;
  await listener.start();
  assert.deepEqual(seen, ['boom', 'summary'], 'a throwing command stopped the batch');
});

test('a revoked token rejects instead of retrying forever', async () => {
  const api = {
    listener: null,
    impl: async () => ({ json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }),
  };
  const listener = createTelegramListener({
    token: 'bad', botName: 'bot-nitin', log, allowedIds: [777], fetchImpl: api.impl,
    onCommand: async () => {},
  });
  await assert.rejects(() => listener.start(), /Unauthorized/);
  await assert.rejects(() => listener.connect(), /Unauthorized/);
});

// ── commandParser under transport: "dual" ─────────────────────────────────────

const dualConfig = (extra = {}) => ({
  botDir: '.',
  botName: 'bot-nitin',
  profile: 'full',
  transport: 'dual',
  paidGroups: ['g1@g.us', 'g2@g.us'],
  groupLinks: ['1. GROUP A:\n https://chat.whatsapp.com/AAA111'],
  joining: { fee: 90 },
  renewal: { fullAmount: 90, referralAmount: 45, billingCycleDays: 30 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'r', overdue: 'o', finalReminder: 'f' },
  ...extra,
});

function fakeStore(members = []) {
  const rows = members.map(m => ({ ...m }));
  return {
    rows,
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    findByName: n => rows.filter(m => m.name.toLowerCase().includes(n.toLowerCase())),
    async refresh() {},
    async add(m) { rows.push({ ...m }); return m; },
    async update(phone, u) { Object.assign(rows.find(m => m.phone === phone), u); return null; },
    async updateMany() { return { updated: 0, missing: [] }; },
  };
}

const groupManagerStub = {
  async removeFromAllGroups() { return { removed: ['g1@g.us'], failed: [] }; },
  async addToAllGroups() { return { added: [], failed: [] }; },
  async sendToMember() { return { sent: 1, failed: 0 }; },
  async getInviteLinksForMissing() { return []; },
  async checkMembership() { return {}; },
  async getAllPendingRequests() { return []; },
  async approveAllPendingRequests() { return { approved: [], failed: [] }; },
  async rejectAllPendingRequests() { return { rejected: [], failed: [] }; },
  async approveByPhone() { return {}; },
  async rejectByPhone() { return {}; },
  markAborted() {},
};

// getSock is the 12th argument; the live socket is what socketDown() interrogates.
function dualParser({ connected, store = fakeStore(), config = dualConfig() } = {}) {
  const sock = connected ? { user: { id: '919999999999:1@s.whatsapp.net' } } : null;
  return createCommandParser(
    store, groupManagerStub, config, log, sock, Date.now(),
    null, null, null, new Set(), null, () => sock,
  );
}

test('with the socket LIVE, dual runs the group commands — no refusal, no banner', async () => {
  const parser = dualParser({ connected: true });
  const reply = await parser.parse('groupcheck 9855112233');
  assert.ok(!reply.includes('DISCONNECTED'), `a healthy bot showed the down banner: ${reply}`);
  assert.ok(!reply.includes('connection is DOWN'), `a healthy bot refused a group command: ${reply}`);
});

test('with the socket DOWN, a pure group command is refused and says why', async () => {
  const parser = dualParser({ connected: false });
  const reply = await parser.parse('groupcheck 9855112233');
  assert.match(reply, /connection is DOWN/, `no clear cause given: ${reply}`);
  assert.match(reply, /403/, 'the refusal should point at how to check the real cause');
  assert.ok(!reply.includes('runs on Telegram'),
    'wording claims the bot has no WhatsApp at all, which is wrong for dual');
});

test('with the socket DOWN, sheet commands still answer and carry the banner', async () => {
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'ACTIVE', billingDate: '01-09-2026', renewals: 0 }]);
  const parser = dualParser({ connected: false, store });
  const reply = await parser.parse('find Raju');
  assert.match(reply, /Raju/, 'the sheet lookup broke with the socket down — this is the whole point of dual');
  assert.match(reply, /WhatsApp is DISCONNECTED/, 'no warning that group actions are dead');
});

test('the banner rides on the first part of a multi-part reply, not every part', async () => {
  const parser = dualParser({ connected: false });
  const out = await parser.parse('help');
  const parts = Array.isArray(out) ? out : [out];
  assert.match(parts[0], /WhatsApp is DISCONNECTED/);
  for (const p of parts.slice(1)) {
    assert.ok(!p.includes('WhatsApp is DISCONNECTED'), 'the banner repeated on a later part');
  }
});

test('"start removal" is refused with the dual wording, not the Telegram wording', async () => {
  const parser = dualParser({ connected: false });
  const reply = await parser.parse('start removal');
  assert.match(reply, /connection is DOWN/);
  assert.ok(!reply.includes('runs on Telegram'), 'wrong cause reported for a dual bot');
});

test('a WhatsApp-only bot is completely unaffected by the dual guards', async () => {
  const config = dualConfig({ transport: 'whatsapp' });
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'ACTIVE', billingDate: '01-09-2026', renewals: 0 }]);
  // Socket down on a plain WhatsApp bot: no banner, because there is no second channel to
  // explain anything to. Behaviour must be byte-identical to before this feature existed.
  const parser = createCommandParser(
    store, groupManagerStub, config, log, null, Date.now(),
    null, null, null, new Set(), null, () => null,
  );
  const reply = await parser.parse('find Raju');
  assert.match(reply, /Raju/);
  assert.ok(!reply.includes('DISCONNECTED'), `banner leaked onto a non-dual bot: ${reply}`);
});
