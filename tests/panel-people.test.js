import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeople } from '../panel/lib/people.js';

const m = (phone, status, extra = {}) => ({ name: `N${phone.slice(-2)}`, phone, status, billingDate: '19-10-2026', ...extra });
const future = new Date(Date.now() + 5 * 86400e3).toISOString();

test('an ACTIVE member who is also in ALL_NUMBERS is one person and not a lead', () => {
  const people = buildPeople({
    sheets: { 'bot-abhi': [m('9876543210', 'ACTIVE')] },
    allNumbers: [['9876543210', 'Gurpreet']],
  });
  assert.equal(people.size, 1);
  const p = people.get('9876543210');
  assert.equal(p.lead, null);
  assert.equal(p.active.length, 1);
  assert.equal(p.name, 'N10', 'sheet name wins over the ALL_NUMBERS name');
});

test('a removed member in ALL_NUMBERS is a lead tagged with the old bot', () => {
  const people = buildPeople({
    sheets: { 'bot-abhi': [m('9876543210', 'REMOVED')] },
    allNumbers: [['9876543210', 'Gurpreet']],
  });
  assert.deepEqual(people.get('9876543210').lead, { exMember: 'bot-abhi (REMOVED)' });
});

test('phone formats collapse to one person across sources', () => {
  const people = buildPeople({
    sheets: { 'bot-abhi': [m('9876543210', 'ACTIVE')], 'bot-nitin': [m('9876543210', 'REMOVED')] },
    allNumbers: [['+91 98765 43210', 'X'], [919876543210, 'Y'], ['', 'blank row']],
    app: [{ phone: '919876543210', status: 'active', expiresAt: future, paidCount: 1 }],
  });
  assert.equal(people.size, 1);
  const p = people.get('9876543210');
  assert.equal(p.members.length, 2);
  assert.equal(p.paidOnApp, true);
  assert.equal(p.onApp, true);
});

test('ALL_NUMBERS-only phone is a fresh lead; expired app plan is not paid', () => {
  const people = buildPeople({
    sheets: {},
    allNumbers: [['9000000001', 'New guy']],
    app: [{ phone: '9000000001', status: 'active', expiresAt: '2020-01-01T00:00:00.000Z' }],
  });
  const p = people.get('9000000001');
  assert.deepEqual(p.lead, { exMember: '' });
  assert.equal(p.name, 'New guy');
  assert.equal(p.paidOnApp, false);
});

test('app state comes from payments, not the app status', () => {
  const live = '2099-01-01T00:00:00.000Z', gone = '2020-01-01T00:00:00.000Z';
  const cases = [
    ['9000000011', { status: 'active', paidCount: 1, expiresAt: live }, 'member'],
    ['9000000012', { status: 'active', paidCount: 0, expiresAt: live }, 'signed_up'],   // free/manual plan
    ['9000000013', { status: 'active', paidCount: 2, expiresAt: gone }, 'lapsed'],
    ['9000000014', { status: 'expired', paidCount: 0 }, 'signed_up'],
    ['9000000015', null, 'none'],
    ['9000000016', { status: 'active', paidCount: 3, expiresAt: live, lastPaidAt: '2026-09-21T18:10:49Z' }, 'signed_up'],   // paid only before launch
  ];
  const people = buildPeople({
    sheets: { 'bot-abhi': cases.map(([ph]) => m(ph, 'ACTIVE')) },
    app: cases.filter(c => c[1]).map(([phone, r]) => ({ lastPaidAt: '2026-10-16T10:00:00Z', ...r, phone })),
    launch: '2026-10-14T18:30:00.000Z',
  });
  for (const [ph, , want] of cases) {
    assert.equal(people.get(ph).appState, want, ph);
    assert.equal(people.get(ph).onApp, want === 'member', ph);
  }
});
