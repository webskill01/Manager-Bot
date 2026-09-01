import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandQueue } from '../core/commandQueue.js';
import { createTelegramListener } from '../core/telegramTransport.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// ── the queue itself ─────────────────────────────────────────────────────────

test('two slow commands never overlap', async () => {
  const q = createCommandQueue(log);
  const order = [];
  const first = defer();

  q.enqueue('approve', async () => { order.push('a-start'); await first.promise; order.push('a-end'); });
  q.enqueue('kickall', async () => { order.push('b-start'); order.push('b-end'); });

  // The second must not have started while the first is still waiting.
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['a-start'], 'the second command started before the first finished');

  first.resolve();
  await q.idle();
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('the receipt can name what a command is waiting behind', async () => {
  const q = createCommandQueue(log);
  const held = defer();
  q.enqueue('approve 98', () => held.promise);
  await new Promise(r => setImmediate(r));

  assert.equal(q.status().running, 'approve 98');
  q.enqueue('kickall', async () => {});
  assert.deepEqual(q.status().waiting, ['kickall'], 'a queued command is not reported as waiting');

  held.resolve();
  await q.idle();
  assert.equal(q.status().running, null);
});

// One throwing command used to be able to wedge every command typed after it, for the life
// of the process, with nothing in the log tying the silence to the failure.
test('a command that throws does not wedge the ones behind it', async () => {
  const errors = [];
  const q = createCommandQueue({ ...log, error: (t) => errors.push(t) });
  const ran = [];

    // enqueue never rejects — the queue owns the error and logs it.
  q.enqueue('approve', async () => { throw new Error('sheet write failed'); });
  q.enqueue('kick', async () => { ran.push('kick'); });
  await q.idle();

  assert.deepEqual(ran, ['kick'], 'the queue stopped after a failure');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /approve.*sheet write failed/);
});

test('idle waits for untracked-looking quick work too', async () => {
  const q = createCommandQueue(log);
  const done = [];
  q.track(new Promise(r => setTimeout(r, 20)).then(() => done.push('quick')));
  await q.idle();
  assert.deepEqual(done, ['quick']);
});

// ── through the real Telegram path ───────────────────────────────────────────

// The bug this all exists for: the poll loop awaited every command before asking Telegram
// for the next update, so an `approve` pacing group adds for two minutes meant `find` and
// `status` were never even collected — the bot looked dead until it finished.
test('a quick lookup answers while a slow command is still running', async () => {
  const sent = [];
  const slow = defer();
  let served = false;
  let listener = null;

  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { username: 'b' } }) };
    if (method === 'sendMessage') {
      sent.push(body.text);
      return { json: async () => ({ ok: true, result: {} }) };
    }
    if (method === 'getUpdates') {
      if (body.offset === -1) return { json: async () => ({ ok: true, result: [] }) };
      if (served) { listener.stop(); return { json: async () => ({ ok: true, result: [] }) }; }
      served = true;
      return {
        json: async () => ({ ok: true, result: [
          // Both in ONE batch, so this also covers the second half of the old block: a slow
          // command used to hold up every update behind it in the same poll response.
          { update_id: 1, message: { from: { id: 7 }, chat: { id: 7 }, text: 'kickall' } },
          { update_id: 2, message: { from: { id: 7 }, chat: { id: 7 }, text: 'summary' } },
        ] }),
      };
    }
    throw new Error(`unexpected ${method}`);
  };

  listener = createTelegramListener({
    token: 't', botName: 'bot-test', log, allowedIds: [7], fetchImpl,
    onCommand: async (text, reply) => {
      if (text === 'kickall') { await slow.promise; return reply('kickall done'); }
      return reply(`answer: ${text}`);
    },
  });

  await listener.start();
  // kickall is still blocked on `slow`, and summary has already been answered.
  assert.ok(sent.includes('answer: summary'), 'the quick lookup was stuck behind the slow command');
  assert.ok(!sent.includes('kickall done'), 'the slow command finished early — the test proves nothing');
  // The receipt says it landed, so the operator is not left guessing.
  assert.ok(sent.some(t => /Got it.*kickall/.test(t)), 'no receipt for the slow command');

  slow.resolve();
  await listener.idle();
  assert.ok(sent.includes('kickall done'), 'the slow command never completed');
});

test('a second slow command is told what it is waiting behind', async () => {
  const sent = [];
  const slow = defer();
  let served = false;
  let listener = null;

  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === 'sendMessage') { sent.push(body.text); return { json: async () => ({ ok: true, result: {} }) }; }
    if (method === 'getUpdates') {
      if (body.offset === -1) return { json: async () => ({ ok: true, result: [] }) };
      if (served) { listener.stop(); return { json: async () => ({ ok: true, result: [] }) }; }
      served = true;
      return {
        json: async () => ({ ok: true, result: [
          { update_id: 1, message: { from: { id: 7 }, chat: { id: 7 }, text: 'kickall' } },
          { update_id: 2, message: { from: { id: 7 }, chat: { id: 7 }, text: 'warnall' } },
        ] }),
      };
    }
    throw new Error(`unexpected ${method}`);
  };

  listener = createTelegramListener({
    token: 't', botName: 'bot-test', log, allowedIds: [7], fetchImpl,
    onCommand: async (text, reply) => {
      if (text === 'kickall') { await slow.promise; return reply('kickall done'); }
      return reply(`${text} done`);
    },
  });

  await listener.start();
  assert.ok(sent.some(t => /Queued behind "kickall"/.test(t)),
    'the second slow command claimed to be running when it was waiting');
  assert.ok(!sent.includes('warnall done'), 'two slow commands ran at once');

  slow.resolve();
  await listener.idle();
  assert.ok(sent.includes('warnall done'), 'the queued command never ran');
});
