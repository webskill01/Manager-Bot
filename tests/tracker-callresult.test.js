import { test } from 'node:test';
import assert from 'node:assert';
import { createTrackerHandlers } from '../core/handlers/trackerHandlers.js';

const log = { info() {}, warn() {}, error() {} };

function fakeStore(members) {
  const rows = members.map(m => ({ callResult: '', callDate: '', ...m }));
  return {
    async refresh() {},
    getAll: () => rows,
    findByPhone: p => rows.find(m => m.phone === p),
    async update(phone, updates) {
      Object.assign(rows.find(m => m.phone === phone), updates);
    },
  };
}

const cfg = { botName: 'bot-x', paidGroups: [], tracker: { callAfterDays: 30, followUpDays: 3 } };
const groupManager = { async removeFromAllGroups() { return { removed: [], failed: [] }; } };

test('called with no outcome keeps today behaviour and leaves callResult blank', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: '01-06-2026' }]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  await h.handleCalled(['9000000001']);
  const m = store.findByPhone('9000000001');
  assert.equal(m.status, 'CALLED');
  assert.equal(m.callResult, '');
  assert.ok(m.callDate, 'callDate stamped');
});

test('called ... interested / not interested write callResult, status stays CALLED', async () => {
  const store = fakeStore([
    { name: 'A', phone: '9000000001', status: 'NEW', joinDate: '01-06-2026' },
    { name: 'B', phone: '9000000002', status: 'NEW', joinDate: '01-06-2026' },
  ]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  await h.handleCalled(['9000000001', 'interested']);
  await h.handleCalled(['9000000002', 'not', 'interested']);
  assert.equal(store.findByPhone('9000000001').callResult, 'interested');
  assert.equal(store.findByPhone('9000000002').callResult, 'not-interested');
  assert.equal(store.findByPhone('9000000002').status, 'CALLED', 'status must not become NOT_INTERESTED');
});

test('a not-interested member can be flipped back to interested', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'CALLED', joinDate: '01-06-2026', callResult: 'not-interested' }]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  await h.handleCalled(['9000000001', 'interested']);
  assert.equal(store.findByPhone('9000000001').callResult, 'interested');
});

test('an unrecognised outcome word is rejected, nothing is written', async () => {
  const store = fakeStore([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: '01-06-2026' }]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  const reply = await h.handleCalled(['9000000001', 'maybe']);
  assert.match(reply, /interested/);
  assert.equal(store.findByPhone('9000000001').status, 'NEW', 'unchanged on bad input');
});

test('pending keeps only pitches with no answer logged — either answer resolves it', async () => {
  const old = '01-01-2026';
  const store = fakeStore([
    { name: 'Keen', phone: '9000000001', status: 'CALLED', joinDate: old, callDate: old, callResult: 'interested' },
    { name: 'Nope', phone: '9000000002', status: 'CALLED', joinDate: old, callDate: old, callResult: 'not-interested' },
    { name: 'Silent', phone: '9000000003', status: 'CALLED', joinDate: old, callDate: old, callResult: '' },
  ]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  const msg = await h.handlePending();
  assert.match(msg, /9000000003/, 'no answer logged — still needs chasing');
  assert.doesNotMatch(msg, /9000000001/, 'interested is an answer — resolved');
  assert.doesNotMatch(msg, /9000000002/, 'not-interested is an answer — resolved');
});

test('REMOVED people never appear in pending or the log, whatever was logged about them', async () => {
  const old = '01-01-2026';
  const store = fakeStore([
    { name: 'GoneKeen', phone: '9000000001', status: 'REMOVED', joinDate: old, callDate: old, callResult: 'interested' },
    { name: 'GoneNo', phone: '9000000002', status: 'REMOVED', joinDate: old, callDate: old, callResult: 'not-interested' },
    { name: 'GoneSilent', phone: '9000000003', status: 'REMOVED', joinDate: old, callDate: old, callResult: '' },
    { name: 'GoneUncalled', phone: '9000000004', status: 'REMOVED', joinDate: old },
    { name: 'Here', phone: '9000000005', status: 'NEW', joinDate: old },
  ]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);

  const pending = await h.handlePending();
  const logOut = (await h.handleLog()).join('\n');
  for (const gone of ['9000000001', '9000000002', '9000000003', '9000000004']) {
    assert.ok(!pending.includes(gone), `${gone} must not be in pending`);
    assert.ok(!logOut.includes(gone), `${gone} must not be in the log`);
  }
  assert.match(pending, /9000000005/);
  assert.match(logOut, /In groups: 1/, 'counts exclude removed people');
});

test('log reports both outcome buckets by name', async () => {
  const old = '01-01-2026';
  const store = fakeStore([
    { name: 'Keen', phone: '9000000001', status: 'CALLED', joinDate: old, callDate: old, callResult: 'interested' },
    { name: 'Nope', phone: '9000000002', status: 'CALLED', joinDate: old, callDate: old, callResult: 'not-interested' },
  ]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  const msg = (await h.handleLog()).join('\n');
  assert.match(msg, /✅ INTERESTED \(1\)/);
  assert.match(msg, /❌ NOT INTERESTED \(1\)/);
  assert.match(msg, /Keen/);
  assert.match(msg, /Nope/);
});

// ── logging a call for someone who was never added to the sheet ───────────────

function fakeStoreWithAdd(members) {
  const store = fakeStore(members);
  const rows = store.getAll();
  return {
    ...store,
    async add(data) {
      rows.push({ callResult: '', callDate: '', ...data });
      return rows[rows.length - 1];
    },
  };
}

test('called on an unknown number asks for the name, writes nothing', async () => {
  const store = fakeStoreWithAdd([]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  const reply = await h.handleCalled(['9000000009', 'interested']);
  assert.match(reply, /name/i);
  assert.match(reply, /called 9000000009 interested \[Name\]/);
  assert.equal(store.getAll().length, 0, 'no row created without a name');
});

test('called on an unknown number WITH a name creates the row, already CALLED + outcome', async () => {
  const store = fakeStoreWithAdd([]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  const reply = await h.handleCalled(['9000000009', 'not', 'interested', 'Rahul', 'Kumar']);
  const m = store.findByPhone('9000000009');
  assert.ok(m, 'row created');
  assert.equal(m.name, 'Rahul Kumar');
  assert.equal(m.status, 'CALLED');
  assert.equal(m.callResult, 'not-interested');
  assert.ok(m.callDate, 'callDate stamped');
  assert.equal(m.paidLast, 0, 'must not count as join revenue');
  assert.match(reply, /added as a new row/);
});

test('a name after the outcome does not break an existing member', async () => {
  const store = fakeStoreWithAdd([{ name: 'A', phone: '9000000001', status: 'NEW', joinDate: '01-06-2026' }]);
  const h = createTrackerHandlers(store, groupManager, cfg, log);
  await h.handleCalled(['9000000001', 'interested', 'Ignored', 'Name']);
  const m = store.findByPhone('9000000001');
  assert.equal(m.callResult, 'interested');
  assert.equal(m.name, 'A', 'existing name untouched');
});
