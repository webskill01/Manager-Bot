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
  assert.equal(isSlowCommand('dmlist 7 msg1'), true);
});

test('the removed group commands are no longer slow commands', () => {
  assert.equal(isSlowCommand('remindall'), false);
  assert.equal(isSlowCommand('catchup 8'), false);
  assert.equal(isSlowCommand('stop catchup'), false);
});

test('dmlist is renewal-only and the dead group commands are gone', () => {
  assert.match(parserSrc, /RENEWAL_ONLY = new Set\(\[[\s\S]*?'dmlist'/, 'dmlist gated to full profile');
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

test('dmlist end-to-end: real parser, real templates, tappable links', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const store = fakeStore([
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: dayOffset(0) },
    { name: 'Jaswinder', phone: '9000000002', status: 'ACTIVE', billingDate: dayOffset(-6) },
    { name: 'Future', phone: '9000000003', status: 'ACTIVE', billingDate: dayOffset(5) },
  ]);
  const parser = makeParser(store, botDir);

  const out = await parser.parse('dmlist 7');
  const text = Array.isArray(out) ? out.join('\n') : out;

  assert.match(text, /DM LIST/);
  assert.match(text, /2 person\(s\)/, 'the future-dated member is excluded');
  assert.doesNotMatch(text, /9000000003/, 'nobody is chased before their month is up');
  // Most overdue first, and each gets its own stage's wording.
  assert.ok(text.indexOf('Jaswinder') < text.indexOf('Gurpreet'), 'sorted most-overdue first');
  assert.match(text, /wa\.me\/919000000001\?text=/);
  assert.match(decodeURIComponent(text), /Sat Sri Akal Gurpreet ji/);
  assert.match(decodeURIComponent(text), /Jaswinder ji, aaj last din/, '6d overdue gets the final wording');
});

test('dmlist 7 msg1 gives the backlog one consistent first-contact message', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const store = fakeStore([
    { name: 'Gurpreet', phone: '9000000001', status: 'ACTIVE', billingDate: dayOffset(0) },
    { name: 'Jaswinder', phone: '9000000002', status: 'ACTIVE', billingDate: dayOffset(-6) },
  ]);
  const parser = makeParser(store, botDir);

  const text = (await parser.parse('dmlist 7 msg1')).join('\n');
  const decoded = decodeURIComponent(text);
  assert.match(text, /Forced: msg1/);
  assert.match(decoded, /Sat Sri Akal Gurpreet ji/);
  assert.match(decoded, /Sat Sri Akal Jaswinder ji/, '6d overdue must NOT get the final notice');
  assert.doesNotMatch(decoded, /aaj last din/);
});

test('dmlist rejects a bad argument instead of silently defaulting', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const parser = makeParser(fakeStore([]), botDir);
  const out = await parser.parse('dmlist banana');
  assert.match(out, /Unknown argument "banana"/);
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
