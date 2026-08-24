import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSlowCommand, createCommandParser } from '../core/commandParser.js';
import { createReminderSender } from '../core/reminderSender.js';
import { formatDate } from '../core/globalConfig.js';

const parserSrc = fs.readFileSync(new URL('../core/commandParser.js', import.meta.url), 'utf8');
const indexSrc = fs.readFileSync(new URL('../core/index.js', import.meta.url), 'utf8');

test('dmlist is a slow command (gets the instant ack)', () => {
  assert.equal(isSlowCommand('dmlist'), true);
  assert.equal(isSlowCommand('dmlist 27 msg1'), true);
  assert.equal(isSlowCommand('dmlist2'), true);
  assert.equal(isSlowCommand('dmlist3'), true);
});

test('the removed group commands are no longer slow commands', () => {
  assert.equal(isSlowCommand('remindall'), false);
  assert.equal(isSlowCommand('catchup 8'), false);
  assert.equal(isSlowCommand('stop catchup'), false);
});

test('dmlist is renewal-only and the dead group commands are gone', () => {
  const renewalOnlySrc = parserSrc.match(/RENEWAL_ONLY = new Set\(\[([\s\S]*?)\]\)/)[1];
  for (const cmd of ['dmlist', 'dmlist2', 'dmlist3']) {
    assert.ok(renewalOnlySrc.includes(`'${cmd}'`), `${cmd} gated to full profile`);
  }
  assert.doesNotMatch(parserSrc, /case 'remindall'/, 'remindall command removed');
  assert.doesNotMatch(parserSrc, /case 'catchup'/, 'catchup command removed');
  assert.doesNotMatch(parserSrc, /'remindall',/, 'remindall not left in any set');
});

test('tracker bots keep add, analytics and utility commands', () => {
  // The constraint: only renewal commands are gated. These must all still be reachable.
  for (const cmd of ['add', 'addsilent', 'summary', 'revenue', 'find', 'stats',
    'approve', 'kick', 'links', 'notinsheet', 'leftmembers', 'stillin', 'groups', 'weekly']) {
    assert.match(parserSrc, new RegExp(`case '${cmd}':`), `${cmd} case must exist`);
  }
  const renewalOnly = parserSrc.match(/RENEWAL_ONLY = new Set\(\[([\s\S]*?)\]\)/)[1];
  for (const cmd of ['add', 'summary', 'revenue', 'find', 'stats', 'approve', 'kick', 'links']) {
    assert.ok(!renewalOnly.includes(`'${cmd}'`), `${cmd} must NOT be gated away from tracker bots`);
  }
});

test('catchupEngine is fully unwired — no stale state can resume on reconnect', () => {
  assert.doesNotMatch(indexSrc, /createCatchupEngine/, 'catchup engine must not be constructed');
  assert.doesNotMatch(indexSrc, /catchupEngine\.resume\(\)/, 'no resume on reconnect');
  // The file itself stays on disk, unreferenced, until Cloud API has run a clean month.
  assert.ok(fs.existsSync(new URL('../core/catchupEngine.js', import.meta.url)), 'file kept');
});

test('index.js sends array replies as separate messages', () => {
  assert.match(indexSrc, /Array\.isArray\(reply\)/, 'dmlist returns an array of parts');
});

// ── End-to-end through the real command parser ────────────────────────────────
const log = { info() {}, warn() {}, error() {} };

function dayOffset(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function fakeStore(members) {
  const rows = members.map(m => ({ ...m }));
  return {
    rows,
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    async refresh() {},
    async update(phone, updates) {
      Object.assign(rows.find(m => m.phone === phone), updates);
    },
  };
}

const fullConfig = botDir => ({
  botDir,
  botName: 'bot-test',
  paidGroups: ['g1@g.us'],
  joining: { fee: 90 },
  renewal: { fullAmount: 90, referralAmount: 45 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  rateLimits: { circuitBreakerCooldownMs: 1000 },
  messages: {
    reminder: 'Sat Sri Akal {name} ji, {date} — ₹90 pay kardo',
    referralReminder: 'Sat Sri Akal {name} ji — ₹45 only',
    overdue: '{name} ji, date nikal gyi',
    finalReminder: '{name} ji, aaj last din',
  },
});

function makeParser(store, botDir) {
  const reminderSender = createReminderSender(fullConfig(botDir), log);
  return createCommandParser(
    store, {}, fullConfig(botDir), log, { user: {} }, Date.now(),
    {}, {}, {}, new Set(), reminderSender, () => ({ user: {} }),
  );
}

// The daily round is three commands. Each must return ONLY its own cohort — if `dmlist`
// leaked the 6-day people, they would get the plain reminder again instead of the final
// notice, and the escalation the operator is hand-running would never actually escalate.
test('the three daily commands split the round by stage, end-to-end', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const members = [
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: dayOffset(0) },
    { name: 'Harjit', phone: '9000000005', status: 'ACTIVE', billingDate: dayOffset(-5) },
    { name: 'Jaswinder', phone: '9000000002', status: 'ACTIVE', billingDate: dayOffset(-6) },
    { name: 'Balwinder', phone: '9000000004', status: 'ACTIVE', billingDate: dayOffset(-30) },
    { name: 'Future', phone: '9000000003', status: 'ACTIVE', billingDate: dayOffset(5) },
  ];

  const run = async cmd => {
    const out = await makeParser(fakeStore(members), botDir).parse(cmd);
    return Array.isArray(out) ? out.join('\n') : out;
  };

  const due = await run('dmlist');
  assert.match(due, /· due today/);
  assert.match(due, /1 person\(s\)/);
  assert.match(decodeURIComponent(due), /Sat Sri Akal Gurpreet ji/);
  assert.doesNotMatch(due, /9000000003/, 'nobody is chased before their month is up');
  assert.doesNotMatch(due, /9000000002/, 'the 6d member belongs to dmlist3');

  const nudge = await run('dmlist2');
  assert.match(nudge, /· 5 days overdue/);
  assert.match(nudge, /1 person\(s\)/);
  assert.match(decodeURIComponent(nudge), /Harjit ji, date nikal gyi/);

  const final = await run('dmlist3');
  assert.match(final, /· 6 days overdue/);
  assert.match(final, /1 person\(s\)/, 'the 30d member is past the ladder, not on it');
  assert.doesNotMatch(final, /Balwinder/, 'day 7 onward is the removal list, not another notice');
  assert.match(decodeURIComponent(final), /Jaswinder ji, aaj last din/);
  assert.match(final, /wa\.me\/919000000002\?text=/);
});

test('dmlist [date] batches by billing day and defaults everyone to msg1', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const past = new Date();
  past.setDate(past.getDate() - 25);
  const day = past.getDate();
  const other = new Date();
  other.setDate(other.getDate() - 26);

  const store = fakeStore([
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: formatDate(past) },
    { name: 'Jaswinder', phone: '9000000002', status: 'ACTIVE', billingDate: formatDate(other) },
  ]);
  const text = (await makeParser(store, botDir).parse(`dmlist ${day}`)).join('\n');

  assert.match(text, new RegExp(`· billed on the ${day}(st|nd|rd|th)`));
  assert.match(text, /1 person\(s\)/, 'only the matching billing day');
  assert.match(text, /Forced: msg1/);
  // 25 days overdue would auto-escalate to the final notice — the default must not.
  assert.match(decodeURIComponent(text), /Sat Sri Akal Gurpreet ji/);
  assert.doesNotMatch(decodeURIComponent(text), /aaj last din/);
});

test('dmlist [date] msg3 escalates the whole batch deliberately', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const past = new Date();
  past.setDate(past.getDate() - 25);
  const store = fakeStore([
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: formatDate(past) },
  ]);
  const text = (await makeParser(store, botDir).parse(`dmlist ${past.getDate()} msg3`)).join('\n');
  assert.match(text, /Forced: msg3/);
  assert.match(decodeURIComponent(text), /Gurpreet ji, aaj last din/);
});

test('dmlist rejects bad arguments instead of silently defaulting', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const parser = makeParser(fakeStore([]), botDir);

  assert.match(await parser.parse('dmlist banana'), /Unknown argument "banana"/);
  // 45 is not a day of the month. Silently clamping it would quietly send the wrong batch.
  assert.match(await parser.parse('dmlist 45'), /Unknown argument "45"/);
  // A date on dmlist2/3 would mean "billed on the 27th AND exactly 5d overdue" — near-always
  // nobody, so it points at the form that actually works.
  assert.match(await parser.parse('dmlist2 27'), /dmlist2 takes no date/);
  assert.match(await parser.parse('dmlist2 27'), /dmlist 27 msg2/);
  assert.match(await parser.parse('dmlist3 27'), /dmlist 27 msg3/);
});

test('dmlist auto-renews 2-ref members and never lists them', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const store = fakeStore([
    { name: 'Boss', phone: '9000000009', status: 'ACTIVE', billingDate: dayOffset(0), renewals: 0, paidLast: 90 },
    { name: 'R1', phone: '9000000001', status: 'ACTIVE', billingDate: dayOffset(20), reference: '9000000009', refCreditDate: dayOffset(-5) },
    { name: 'R2', phone: '9000000002', status: 'ACTIVE', billingDate: dayOffset(20), reference: '9000000009', refCreditDate: dayOffset(-5) },
  ]);
  const parser = makeParser(store, botDir);

  const text = (await parser.parse('dmlist')).join('\n');
  assert.match(text, /Auto-renewed \(2 refs, no payment due\): Boss/);
  assert.doesNotMatch(text, /wa\.me\/919000000009/, 'nobody who owes nothing is chased');
  assert.equal(store.findByPhone('9000000009').paidLast, 0);
});
