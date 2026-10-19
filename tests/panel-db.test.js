import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../panel/lib/db.js';
import { hashPw, checkPw, createRateLimit } from '../panel/lib/auth.js';

test('password hash round-trips and rejects a wrong password', () => {
  const h = hashPw('correct horse');
  assert.ok(checkPw('correct horse', h));
  assert.ok(!checkPw('wrong', h));
  assert.ok(!checkPw('x', ''));
});

test('rate limit blocks the 6th failure inside the window', () => {
  let now = 0;
  const rl = createRateLimit({ max: 5, windowMs: 15 * 60e3, now: () => now });
  for (let i = 0; i < 5; i++) { assert.ok(rl.allowed('ip')); rl.fail('ip'); }
  assert.ok(!rl.allowed('ip'));
  now = 16 * 60e3;
  assert.ok(rl.allowed('ip'));
});

test('a promise opens a follow-up and closes the older one for that phone', () => {
  const db = openDb(':memory:');
  const u = db.createUser({ name: 'ravi', role: 'caller', pwHash: 'x' });
  db.logInteraction({ phone: '9876543210', bot: 'bot-abhi', userId: u, outcome: 'callback', dueAt: '2026-10-20T10:00:00.000Z' });
  db.logInteraction({ phone: '9876543210', bot: 'bot-abhi', userId: u, outcome: 'promise', dueAt: '2026-10-22T00:00:00.000Z', note: 'monday' });
  const open = db.openFollowups();
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'promise');
  assert.equal(db.timeline('9876543210').length, 2);
});

test('paid outcome closes open follow-ups and opens none', () => {
  const db = openDb(':memory:');
  const u = db.createUser({ name: 'ravi', role: 'caller', pwHash: 'x' });
  db.logInteraction({ phone: '9876543210', bot: 'bot-abhi', userId: u, outcome: 'promise', dueAt: '2026-10-22T00:00:00.000Z' });
  db.logInteraction({ phone: '9876543210', bot: 'bot-abhi', userId: u, outcome: 'paid' });
  assert.equal(db.openFollowups().length, 0);
});

test('claim refuses another user until it expires', () => {
  const db = openDb(':memory:');
  const t0 = new Date('2026-10-19T10:00:00Z');
  assert.ok(db.claim('9876543210', 1, t0));
  assert.ok(!db.claim('9876543210', 2, new Date(t0.getTime() + 5 * 60e3)));
  assert.ok(db.claim('9876543210', 1, new Date(t0.getTime() + 5 * 60e3)), 'same user re-claims');
  assert.ok(db.claim('9876543210', 2, new Date(t0.getTime() + 16 * 60e3)));
});

test('sessions resolve to active users only', () => {
  const db = openDb(':memory:');
  const u = db.createUser({ name: 'Nitin', role: 'admin', pwHash: 'x' });
  db.addSession('h1', u, new Date(Date.now() + 60e3));
  assert.equal(db.sessionUser('h1').name, 'Nitin');
  db.updateUser(u, { active: 0 });
  assert.equal(db.sessionUser('h1'), null);
  assert.equal(db.userByName('nitin').id, u, 'names are case-insensitive');
});
