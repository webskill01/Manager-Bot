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
    app: [{ phone: '919876543210', status: 'active', expiresAt: future }],
  });
  assert.equal(people.size, 1);
  const p = people.get('9876543210');
  assert.equal(p.members.length, 2);
  assert.equal(p.paidOnApp, true);
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
