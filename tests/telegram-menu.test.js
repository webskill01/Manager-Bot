import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTelegramListener } from '../core/telegramTransport.js';

const log = { info() {}, warn() {}, error() {} };

// Records every API call and answers the two the transport makes at connect().
function stubFetch(calls) {
  return async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    calls.push({ method, body });
    const result = method === 'getMe' ? { username: 'test_bot' } : true;
    return { json: async () => ({ ok: true, result }) };
  };
}

function listener(extra = {}, calls = []) {
  return {
    calls,
    tg: createTelegramListener({
      token: 't', allowedIds: [1], botName: 'bot-test', log,
      onCommand: async () => {}, fetchImpl: stubFetch(calls), ...extra,
    }),
  };
}

test('connect fills the / menu with commands the parser actually knows', async () => {
  const parser = fs.readFileSync('core/commandParser.js', 'utf8');
  for (const profile of ['full', 'tracker']) {
    const { tg, calls } = listener({ profile });
    await tg.connect();
    const set = calls.find(c => c.method === 'setMyCommands');
    assert.ok(set, `${profile}: setMyCommands never sent`);
    for (const { command, description } of set.body.commands) {
      // A menu entry that answers "❓ Unknown command" is worse than no menu entry.
      assert.ok(parser.includes(`case '${command}'`), `${profile}: /${command} is not a real command`);
      assert.ok(/^[a-z0-9_]{1,32}$/.test(command), `${profile}: /${command} breaks Telegram's naming rule`);
      assert.ok(description.length > 0 && description.length <= 256, `${profile}: /${command} description length`);
    }
  }
});

test('a bad setMyCommands does not stop the bot from starting', async () => {
  const tg = createTelegramListener({
    token: 't', allowedIds: [1], botName: 'bot-test', log, onCommand: async () => {},
    fetchImpl: async (url) => url.endsWith('getMe')
      ? { json: async () => ({ ok: true, result: { username: 'test_bot' } }) }
      : { json: async () => ({ ok: false, description: 'nope', error_code: 400 }) },
  });
  assert.deepEqual(await tg.connect(), { username: 'test_bot' });
});

test('no reply carries a persistent keyboard — it was retired for eating the screen', async () => {
  const { tg, calls } = listener();
  await tg.send(1, 'x'.repeat(4000));
  const sends = calls.filter(c => c.method === 'sendMessage');
  assert.equal(sends.length, 2);
  for (const s of sends) assert.equal(s.body.reply_markup?.keyboard, undefined);
});

test('the first chunk clears the keyboard operators are still stuck with', async () => {
  const { tg, calls } = listener();
  await tg.send(1, 'x'.repeat(4000));
  const sends = calls.filter(c => c.method === 'sendMessage');
  assert.equal(sends[0].body.reply_markup?.remove_keyboard, true);
  assert.equal(sends[1].body.reply_markup, undefined, 'removal repeated on a continuation chunk');
});

test('bootstrap mode sends no reply_markup at all — nobody there can run anything yet', async () => {
  const { tg, calls } = listener({ bootstrapMode: true });
  await tg.send(1, 'hi');
  assert.equal(calls[0].body.reply_markup, undefined);
});

// ── follow-up buttons ─────────────────────────────────────────────────────────
import { followUps } from '../core/telegramTransport.js';

const allButtons = (rows) => rows.flat();

test('the prose menus become buttons', () => {
  assert.deepEqual(allButtons(followUps('stop')).map(b => b[0]),
    ['stop removal', 'stop kickall', 'stop kickghosts']);
  assert.deepEqual(allButtons(followUps('drip')).map(b => b[0]),
    ['drip plan', 'drip start', 'drip stop', 'drip test']);
  assert.deepEqual(allButtons(followUps('kickghosts')).map(b => b[0]),
    ['kickghosts confirm', 'stop kickghosts']);
});

test('drip keeps its buttons after start/stop/test — the next steps are the same three', () => {
  for (const sub of ['drip plan', 'drip start', 'drip stop', 'drip test']) {
    assert.ok(followUps(sub), `${sub} lost its buttons`);
  }
});

test('delayall confirm carries the SAME number the preview used', () => {
  assert.deepEqual(allButtons(followUps('delayall 7')).map(b => b[0]), ['delayall 7 confirm']);
  assert.deepEqual(allButtons(followUps('delayall 30')).map(b => b[0]), ['delayall 30 confirm']);
});

test('no confirm button under a format error', () => {
  // `delayall abc` answers "❌ Days must be a number" — a confirm button there is a trap.
  assert.equal(followUps('delayall abc'), null);
  assert.equal(followUps('delayall'), null);
  assert.equal(followUps('delayall 7 confirm'), null);
});

test('an argument means a different question — no follow-ups', () => {
  assert.equal(followUps('links 9855112233'), null);   // one member's links, not refreshlinks
  assert.equal(followUps('summary 1'), null);          // already IS the follow-up
  assert.equal(followUps('kickghosts confirm'), null);
});

test('commands with no fixed follow-up get none', () => {
  for (const cmd of ['digest', 'find', 'add', 'kick', 'renewed', 'cloudapi', 'setlink', 'monthly']) {
    assert.equal(followUps(cmd), null, `${cmd} should have no buttons`);
  }
});

test('every button is a real command, and fits Telegram callback_data', () => {
  const parser = fs.readFileSync('core/commandParser.js', 'utf8');
  const seen = new Set();
  for (const text of ['drip', 'kickghosts', 'stop', 'summary', 'due', 'upcoming', 'links', 'delayall 7']) {
    for (const [data, label] of allButtons(followUps(text))) {
      seen.add(data);
      assert.ok(Buffer.byteLength(data) <= 64, `callback_data "${data}" exceeds 64 bytes`);
      assert.ok(label.length > 0, `button for "${data}" has no label`);
      assert.ok(parser.includes(`case '${data.split(' ')[0]}'`), `"${data}" is not a real command`);
    }
  }
  assert.ok(seen.size >= 12);
});

test('a tapped button runs exactly what a typed command would', async () => {
  const ran = [];
  const calls = [];
  const tg = createTelegramListener({
    token: 't', allowedIds: [1], botName: 'bot-test', log,
    onCommand: async (text, reply) => { ran.push(text); await reply('ok'); },
    fetchImpl: stubFetch(calls),
  });
  await tg.connect();
  await tg.handleUpdate({ callback_query: { id: 'q1', from: { id: 1 }, message: { chat: { id: 9 } }, data: 'drip stop' } });
  assert.deepEqual(ran, ['drip stop']);
  // The spinner must be stopped whatever else happens.
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery'), 'button left spinning');
});

test('a stranger tapping a button gets the spinner stopped and nothing else', async () => {
  const ran = [];
  const calls = [];
  const tg = createTelegramListener({
    token: 't', allowedIds: [1], botName: 'bot-test', log,
    onCommand: async (text) => { ran.push(text); },
    fetchImpl: stubFetch(calls),
  });
  await tg.handleUpdate({ callback_query: { id: 'q1', from: { id: 999 }, message: { chat: { id: 9 } }, data: 'stop removal' } });
  assert.deepEqual(ran, []);
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery'));
  assert.ok(!calls.some(c => c.method === 'sendMessage'));
});

test('buttons ride the LAST chunk, never a middle one', async () => {
  const calls = [];
  const tg = createTelegramListener({
    token: 't', allowedIds: [1], botName: 'bot-test', log,
    onCommand: async (text, reply) => reply('x'.repeat(4000)),
    fetchImpl: stubFetch(calls),
  });
  await tg.handleUpdate({ message: { from: { id: 1 }, chat: { id: 9 }, text: 'drip' } });
  // `drip` is a slow command, so the ⏳ ack precedes the answer — it is not part of it.
  const sends = calls.filter(c => c.method === 'sendMessage' && !c.body.text.startsWith('⏳'));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].body.reply_markup?.remove_keyboard, true, 'first chunk should still clear the old keyboard');
  assert.ok(sends[1].body.reply_markup?.inline_keyboard, 'last chunk lost its follow-up buttons');
});

test('no follow-up buttons under a refusal', async () => {
  const calls = [];
  const tg = createTelegramListener({
    token: 't', allowedIds: [1], botName: 'bot-test', log,
    onCommand: async (text, reply) => reply('⚠️ Drip unavailable — it needs a Telegram listener.'),
    fetchImpl: stubFetch(calls),
  });
  await tg.handleUpdate({ message: { from: { id: 1 }, chat: { id: 9 }, text: 'drip' } });
  const send = calls.find(c => c.method === 'sendMessage');
  assert.equal(send.body.reply_markup?.inline_keyboard, undefined);
});

// Twenty phone numbers would never fit callback_data's 64 bytes, so the button carries only
// the verb and the phones stay in drip-state. Every dmlist form gets it — the date batches
// are exactly the ones the operator runs to clear an overflow by hand.
test('every dmlist form offers "I sent these", and the claim itself does not', () => {
  for (const cmd of ['dmlist', 'dmlist2', 'dmlist3', 'dmlist 27', 'dmlist 27 msg2']) {
    const rows = followUps(cmd);
    assert.deepEqual(allButtons(rows).map(b => b[0]), ['dmlist done'], `${cmd} lost its button`);
    assert.ok(Buffer.byteLength(rows[0][0][0]) <= 64, 'callback_data over Telegram cap');
  }
  assert.equal(followUps('dmlist done'), null, 'the claim offered to claim itself again');
});
