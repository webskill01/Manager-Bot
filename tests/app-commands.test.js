import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemberHandlers, appPitch } from '../core/handlers/memberHandlers.js';
import { buildPeople, splitBlock, createAppHandlers } from '../core/handlers/appHandlers.js';
import { createFleetView, paidPing } from '../core/fleetView.js';
import { formatDate } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const ddmm = (n) => formatDate(new Date(iso(n)));
const PLAY = 'https://play.google.com/store/apps/details?id=com.easecab.app';
const config = () => ({
  botName: 'bot-abhi', profile: 'full', botDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mb-app-')),
  joining: { fee: 90 }, renewal: { fullAmount: 90, referralAmount: 45 },
  app: { playStoreUrl: PLAY }, messages: { appPitch: ['PITCH ONE 🙏🏻', 'PITCH TWO 🙏🏻', 'PITCH THREE 🙏🏻'] },
});

function memStore(rows = []) {
  rows = rows.map(r => ({ ...r }));
  return {
    rows,
    getAll: () => rows.map(r => ({ ...r })),
    getActive: () => rows.filter(r => r.status === 'ACTIVE'),
    findByPhone: (p) => rows.find(r => r.phone === p) || null,
    async refresh() {},
    async add(m) { rows.push({ status: 'ACTIVE', ...m }); return m; },
    async update(phone, u) { Object.assign(rows.find(r => r.phone === phone), u); },
  };
}
const groupManager = { async getInviteLinksForMissing() { return [{ groupName: 'G', link: 'https://chat.whatsapp.com/AAA' }]; } };
const fakeSync = (row) => ({ async lookup() { return row; }, snapshot: () => new Map(row ? [[row.phone, row]] : []) });

test('add on an app bot: PENDING_APP row, no join fee, the app pitch as tap link + plain text', async () => {
  const store = memStore();
  const h = createMemberHandlers(store, groupManager, config(), log, fakeSync(null));
  const reply = await h.handleAdd(['Ravi', '9000000001']);
  assert.strictEqual(store.rows[0].status, 'PENDING_APP');
  assert.strictEqual(store.rows[0].paidLast, 0);
  assert.match(reply, /waiting for their app payment/);
  assert.match(reply, /wa\.me\/919000000001\?text=/);
  assert.match(reply, /Or copy:\nPITCH (ONE|TWO|THREE) 🙏🏻\nhttps:\/\/play\.google\.com/);
  assert.doesNotMatch(reply, /chat\.whatsapp\.com/, 'no group links before they pay');
  const again = await h.handleAdd(['Ravi', '9000000001']);
  assert.match(again, /already waiting/);
  assert.strictEqual(store.rows.length, 1);
});

test('app pitch varies across phones', () => {
  const seen = new Set(['9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '9000000006']
    .map(p => appPitch(config(), p).split('\n')[0]));
  assert.ok(seen.size > 1);
});

test('add without app sync keeps the old flow', async () => {
  const store = memStore();
  const reply = await createMemberHandlers(store, groupManager, config(), log).handleAdd(['Ravi', '9000000001']);
  assert.strictEqual(store.rows[0].status, 'ACTIVE');
  assert.strictEqual(store.rows[0].paidLast, 90);
  assert.match(reply, /added to sheet/);
});

test('sendlinks: refused unless paid on the app; force overrides; payment activates a pending row', async () => {
  const pending = { name: 'Ravi', phone: '9000000001', status: 'PENDING_APP', renewals: 0 };
  let store = memStore([pending]);
  let h = createMemberHandlers(store, groupManager, config(), log, fakeSync(null));
  assert.match(await h.handleSendLinks(['9000000001']), /has not paid on the app[\s\S]*force/);
  assert.match(await h.handleSendLinks(['9000000001', 'force']), /chat\.whatsapp\.com/);
  assert.strictEqual(store.rows[0].status, 'PENDING_APP', 'force sends links but does not mark paid');

  store = memStore([pending]);
  h = createMemberHandlers(store, groupManager, config(), log,
    fakeSync({ phone: '9000000001', status: 'active', expiresAt: iso(30), lastAmount: 149 }));
  assert.match(await h.handleSendLinks(['9000000001']), /chat\.whatsapp\.com/);
  assert.strictEqual(store.rows[0].status, 'ACTIVE');
  assert.strictEqual(store.rows[0].billingDate, ddmm(30));
  assert.strictEqual(store.rows[0].appPaidUntil, ddmm(30));
});

test('buildPeople splits app only / groups only / both across sheets', () => {
  const sheets = [
    { bot: 'bot-nitin', members: [{ phone: '1', name: 'A', status: 'ACTIVE' }, { phone: '2', name: 'B', status: 'ACTIVE' }] },
    { bot: 'bot-abhi', members: [{ phone: '1', name: 'A', status: 'ACTIVE' }, { phone: '4', name: 'D', status: 'REMOVED' }] },
  ];
  const app = [{ phone: '1', status: 'active', expiresAt: iso(10) }, { phone: '3', status: 'active', expiresAt: iso(10) },
    { phone: '4', status: 'expired', expiresAt: iso(-3) }];
  const p = buildPeople(sheets, app);
  assert.deepStrictEqual(['1', '2', '3', '4'].map(x => p.get(x).kind), ['both', 'groups', 'app', null]);
  assert.deepStrictEqual(p.get('1').bots, ['nitin', 'abhi']);
  const block = splitBlock([...p.values()].filter(x => x.kind));
  assert.match(block, /App \+ groups \(1\)\n    • A · 1 · nitin\+abhi/);
  assert.match(block, /App only \(1\)\n    • \(app user\) · 3/);
});

test('summary: paid only, split; money only on the pooled (fleet) bot', async () => {
  const store = memStore([{ phone: '9000000001', name: 'A', status: 'ACTIVE' }]);
  const row = { phone: '9000000001', status: 'active', expiresAt: iso(30) };
  const client = { async payments() { return { payments: [{ phone: '9000000001', amount: 149, first: true }, { phone: '9000000009', amount: 149, first: false }] }; } };
  const fleet = (isFleet) => ({ isFleet, sheets: async () => [{ bot: 'bot-nitin', members: store.getAll() }] });
  const out = await createAppHandlers({ config: config(), appSync: fakeSync(row), client, fleet: fleet(true), log }).handleSummary();
  assert.match(out, /2 person\(s\)/);
  assert.match(out, /App total: ₹298/);
  assert.match(out, /A · 9000000001 · nitin · 🆕 first/);
  const plain = await createAppHandlers({ config: config(), appSync: fakeSync(row), client, fleet: fleet(false), log }).handleSummary();
  assert.doesNotMatch(plain, /₹/);
  assert.match(plain, /1 person\(s\)/, 'other bots count only phones on their own sheet');
  assert.doesNotMatch(plain, /9000000009|App only/);
  const none = await createAppHandlers({ config: config(), appSync: fakeSync(row), client, fleet: { isFleet: false, sheets: async () => [{ bot: 'bot-abhi', members: [] }] }, log }).handleSummary();
  assert.match(none, /0 person\(s\)/);
  assert.match(await createAppHandlers({ config: config(), appSync: fakeSync(row), client, fleet: fleet(false), log }).handleRevenue(), /bot-nitin only/);
});

test('fleet view reads other sheets read-only and names them in the payment ping', async () => {
  const store = memStore([{ phone: '9000000001', name: 'A', status: 'ACTIVE' }]);
  const fleet = createFleetView({
    config: { botName: 'bot-nitin', fleetSheets: { 'bot-nitin': 'x', 'bot-abhi': 'y' } }, store, log,
    makeClient: async () => ({ getAll: async () => [{ phone: '9000000001', name: 'A2', status: 'PENDING_APP' }] }),
  });
  assert.strictEqual(fleet.isFleet, true);
  const where = await fleet.whereIs('9000000001');
  assert.deepStrictEqual(where.map(w => w.bot), ['bot-nitin', 'bot-abhi']);
  const ping = paidPing({ phone: '9000000001', lastAmount: 149, expiresAt: iso(30) }, where);
  assert.match(ping, /App payment — A \(9000000001\) · ₹149 till/);
  assert.match(ping, /Sheets: nitin \(ACTIVE\), abhi \(PENDING_APP\)/);
  assert.match(paidPing({ phone: '9000000009' }, []), /app only, not in any group sheet/);
});
