import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemovalEngine } from '../core/removalEngine.js';

const log = { info() {}, warn() {}, error() {} };

function makeConfig(botDir) {
  return {
    botDir,
    paidGroups: ['g1@g.us', 'g2@g.us'],
    overdue: { consolidatedListDays: 7 },
    rateLimits: { groupOpGapMinMs: 1, groupOpGapMaxMs: 1 },
  };
}

// An overdue (8 days) ACTIVE member so getRemovalList() picks them up.
function makeMember(phone) {
  const d = new Date();
  d.setDate(d.getDate() - 8);
  const billingDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  return { name: `M${phone}`, phone, status: 'ACTIVE', billingDate, delayUntil: '' };
}

function makeStore(members) {
  return {
    async refresh() {},
    getAll() { return members.map(m => ({ ...m })); },
    getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
    findByPhone(p) { const m = members.find(x => x.phone === p); return m ? { ...m } : null; },
    async update(p, u) { const i = members.findIndex(x => x.phone === p); if (i >= 0) members[i] = { ...members[i], ...u }; },
  };
}

test('a member is NOT marked REMOVED when the socket drops mid-removal', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const config = makeConfig(botDir);
  const members = [makeMember('9000000001')];
  const store = makeStore(members);

  // Socket is alive through the initial guard and the first group removal, then drops — so the
  // group loop is interrupted before finishing all groups (interrupted=true, partial removal).
  let removedOne = false;
  const sock = {
    get user() { return removedOne ? null : { id: 'me' }; },
    async groupParticipantsUpdate() { removedOne = true; },
  };
  const engine = createRemovalEngine(config, log, () => sock, store, () => []);

  engine.kickall();
  await new Promise(r => setTimeout(r, 200));

  // Interrupted mid-removal → must stay ACTIVE (resume retries later), never flipped to REMOVED
  // while still physically in some groups.
  assert.equal(store.findByPhone('9000000001').status, 'ACTIVE');

  engine.stopKickall();
  fs.rmSync(botDir, { recursive: true, force: true });
});

// One buzz per person, and it says what happened. The "next removal in ~22 min" line that used
// to follow every one of them doubled the notification count to deliver a guess.
test('a removal is announced once, with no ETA for the next one', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const store = makeStore([makeMember('9000000001'), makeMember('9000000002')]);
  const sock = { user: { id: 'me' }, async groupParticipantsUpdate() {} };
  const notices = [];
  const engine = createRemovalEngine(makeConfig(botDir), log, () => sock, store, () => [],
    async (t) => { notices.push(t); });

  engine.kickall();
  await new Promise(r => setTimeout(r, 200));

  assert.equal(notices.filter(n => n.includes('removed from')).length, 1);
  assert.deepEqual(notices.filter(n => n.includes('Next removal')), [],
    'the ETA ping is still being sent');

  engine.stopKickall();
  fs.rmSync(botDir, { recursive: true, force: true });
});

test('resume() is safe to call repeatedly and processes at most one member per grace window', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const config = makeConfig(botDir);
  const members = [makeMember('9000000001'), makeMember('9000000002'), makeMember('9000000003')];
  const store = makeStore(members);

  const removed = [];
  const sock = {
    user: { id: 'me' },
    async groupParticipantsUpdate(_group, jids) { removed.push(jids[0]); },
  };
  const engine = createRemovalEngine(config, log, () => sock, store, () => []);

  engine.kickall();
  // Repeated reconnects: each resume() must cancel the pending chain rather than stack a new one.
  for (let i = 0; i < 5; i++) engine.resume();
  await new Promise(r => setTimeout(r, 200));

  // No member should be removed twice (no duplicate group ops for the same member from stacked
  // chains), and the run must not have stampeded through multiple members at once.
  const distinct = new Set(removed);
  assert.equal(removed.length, distinct.size, 'no member removed twice by stacked chains');
  assert.ok(distinct.size <= 1, `at most one member processed per window, got ${distinct.size}`);

  engine.stopKickall();
  fs.rmSync(botDir, { recursive: true, force: true });
});

// App flow: removed the morning after the app plan ends; the 9 AM run touches nobody else.
test('kickall({ appOnly }) removes expired app plans only, and skips anyone who paid since', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const config = makeConfig(botDir);
  const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
  const members = [
    { name: 'App1', phone: '9000000001', status: 'ACTIVE', billingDate: ago(1), appPaidUntil: ago(1), delayUntil: '' },
    { name: 'Old8', phone: '9000000002', status: 'ACTIVE', billingDate: ago(8), appPaidUntil: '', delayUntil: '' },
    { name: 'AppToday', phone: '9000000003', status: 'ACTIVE', billingDate: ago(0), appPaidUntil: ago(0), delayUntil: '' },
  ];
  const store = makeStore(members);
  const removed = [];
  const sock = { user: { id: 'me' }, async groupParticipantsUpdate(_g, [jid]) { removed.push(jid); } };
  const engine = createRemovalEngine(config, log, () => sock, store, () => []);

  const reply = engine.kickall({ appOnly: true });
  assert.match(reply, /Kickall started — 1 members/);
  assert.match(reply, /App1/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(store.findByPhone('9000000001').status, 'REMOVED');
  assert.equal(store.findByPhone('9000000002').status, 'ACTIVE', 'old flow is not auto-removed');
  assert.equal(store.findByPhone('9000000003').status, 'ACTIVE', 'not on the expiry day itself');
  assert.ok(removed.every(j => j.startsWith('919000000001')));

  assert.match(engine.kickall({ appOnly: true }), /No expired app plans/);
  engine.stopKickall();
  fs.rmSync(botDir, { recursive: true, force: true });
});
