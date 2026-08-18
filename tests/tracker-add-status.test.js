import { test } from 'node:test';
import assert from 'node:assert';
import { createMemberHandlers } from '../core/handlers/memberHandlers.js';

const log = { info() {}, warn() {}, error() {} };

// Every add path must stamp status NEW on a tracker bot. If one of them didn't, people
// added that way would sit in the sheet with the wrong status and the call funnel would
// quietly under-report them.
//
// `addnew` was a third path here until 2026-08-18. It was deleted, not renamed: it existed
// only to add someone WITHOUT sending links, and `add` stopped sending anything, so the two
// became one operation. addsilent survives because it differs on something real — paidLast 0.
function harness(profile) {
  const added = [];
  const store = {
    added,
    getAll: () => [],
    getActive: () => [],
    findByPhone: () => null,
    async refresh() {},
    async add(m) { added.push(m); return { ...m }; },
    async update() {},
  };
  const groupManager = {
    async addToAllGroups() { return { added: [], failed: [] }; },
    async removeFromAllGroups() { return { removed: [], failed: [] }; },
    async sendLinks() { return 'sent'; },
    // `add` sends the links + welcome after writing the row; without this it throws
    // AFTER the sheet write, which is exactly the kind of thing this test must survive.
    async sendToMember() { return true; },
  };
  const config = {
    botDir: '.',
    botName: 'bot-test',
    profile,
    paidGroups: ['g1@g.us'],
    joining: { fee: 100 },
    renewal: { fullAmount: 100, referralAmount: 50 },
    groupNames: ['Group A'],
    welcomeMessage: 'welcome',
    messages: {},
    rateLimits: {},
  };
  return { store, h: createMemberHandlers(store, groupManager, config, log) };
}

test('handleNewAdd is gone, not merely unrouted', () => {
  const { h } = harness('tracker');
  assert.equal(h.handleNewAdd, undefined, 'a dead export invites a future caller');
});

test('both add paths stamp NEW on a tracker bot', async () => {
  for (const [label, call] of [
    ['add', h => h.handleAdd(['Amrik', '9876500001'])],
    ['addsilent', h => h.handleSilentAdd(['Balwinder', '9876500002'])],
  ]) {
    const { store, h } = harness('tracker');
    await call(h);
    assert.equal(store.added.length, 1, `${label} added a row`);
    assert.equal(store.added[0].status, 'NEW', `${label} must stamp NEW`);
  }
});

test('none of them stamp NEW on a full-profile bot', async () => {
  for (const [label, call] of [
    ['add', h => h.handleAdd(['Amrik', '9876500001'])],
    ['addsilent', h => h.handleSilentAdd(['Balwinder', '9876500002'])],
  ]) {
    const { store, h } = harness('full');
    await call(h);
    assert.notEqual(store.added[0].status, 'NEW', `${label} must not stamp NEW on a full bot`);
  }
});

// paidLast is the revenue sentinel, and it is where the three paths genuinely differ:
// 0 means "existing member, do not count as a paid join".
test('add counts as a paid join; addsilent does not', async () => {
  const cases = [
    ['add', h => h.handleAdd(['Amrik', '9876500001']), 100],
    ['addsilent', h => h.handleSilentAdd(['Balwinder', '9876500002']), 0],
  ];
  for (const [label, call, expected] of cases) {
    const { store, h } = harness('tracker');
    await call(h);
    assert.equal(store.added[0].paidLast, expected, `${label} paidLast`);
  }
});
