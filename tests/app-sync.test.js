import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { planSync, updatesFor, stalePending, appDate, createAppSync } from '../core/appSync.js';
import { createAppClient } from '../core/appClient.js';
import { formatDate } from '../core/globalConfig.js';

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d; };
const iso = (n) => inDays(n).toISOString();
const ddmm = (n) => formatDate(inDays(n));
const row = (phone, expDays, extra = {}) => ({ phone, status: 'active', expiresAt: iso(expDays), lastAmount: 149, paidCount: 1, lastPaidAt: new Date().toISOString(), ...extra });

test('planSync: a later app expiry renews an ACTIVE row; the same expiry is a no-op', () => {
  const members = [
    { phone: '9000000001', status: 'ACTIVE', appPaidUntil: '' },
    { phone: '9000000002', status: 'ACTIVE', appPaidUntil: ddmm(30) },
    { phone: '9000000003', status: 'ACTIVE', appPaidUntil: ddmm(2) },
  ];
  const plan = planSync(members, [row('9000000001', 30), row('9000000002', 30), row('9000000003', 32)]);
  assert.deepStrictEqual(plan.renew.map(e => e.member.phone), ['9000000001', '9000000003']);
  assert.strictEqual(plan.renew[0].first, true);
  assert.strictEqual(plan.renew[1].first, false);
});

test('planSync: pending and removed rows activate; expired/cancelled subs and past expiries do nothing', () => {
  const members = [
    { phone: '9000000004', status: 'PENDING_APP', appPaidUntil: '' },
    { phone: '9000000005', status: 'REMOVED', appPaidUntil: ddmm(-20) },
    { phone: '9000000006', status: 'ACTIVE', appPaidUntil: '' },
    { phone: '9000000007', status: 'ACTIVE', appPaidUntil: '' },
    { phone: '9000000008', status: 'SKIPPED', appPaidUntil: '' },
  ];
  const plan = planSync(members, [
    row('9000000004', 30), row('9000000005', 30),
    row('9000000006', 30, { status: 'expired' }), row('9000000007', -1), row('9000000008', 30),
  ]);
  assert.deepStrictEqual(plan.activate.map(e => e.member.phone), ['9000000004', '9000000005']);
  assert.deepStrictEqual(plan.renew, []);
  assert.deepStrictEqual(plan.quiet.map(e => e.member.phone), ['9000000008'], 'other statuses only get column S');
});

test('updatesFor: billing date = app expiry, column S set, renewals counted only on renew', () => {
  const member = { phone: '9000000001', status: 'ACTIVE', renewals: 3 };
  const u = updatesFor({ member, until: ddmm(30), amount: 149 }, 'renew');
  assert.strictEqual(u.billingDate, ddmm(30));
  assert.strictEqual(u.appPaidUntil, ddmm(30));
  assert.strictEqual(u.renewals, 4);
  assert.strictEqual(u.status, 'ACTIVE');
  const a = updatesFor({ member: { ...member, status: 'PENDING_APP', renewals: 0 }, until: ddmm(30), amount: 149 }, 'activate');
  assert.strictEqual(a.renewals, 0);
  assert.ok(a.joinDate, 'a pending member joins on the day they pay');
  assert.deepStrictEqual(Object.keys(updatesFor({ member, until: ddmm(30) }, 'quiet')).sort(), ['appPaidUntil', 'delayUntil']);
});

test('stalePending: only PENDING_APP rows 7+ days old, and each only once', () => {
  const members = [
    { phone: '1', status: 'PENDING_APP', joinDate: ddmm(-7) },
    { phone: '2', status: 'PENDING_APP', joinDate: ddmm(-6) },
    { phone: '3', status: 'ACTIVE', joinDate: ddmm(-30) },
    { phone: '4', status: 'PENDING_APP', joinDate: ddmm(-9) },
  ];
  assert.deepStrictEqual(stalePending(members, { 4: 'x' }).map(m => m.phone), ['1']);
});

test('appDate converts an ISO instant to the sheet date format', () => {
  assert.strictEqual(appDate(iso(3)), ddmm(3));
  assert.strictEqual(appDate(null), '');
});

function fakeStore(members) {
  let rows = members.map(m => ({ ...m }));
  return {
    writes: [],
    async refresh() {},
    getAll() { return rows.map(m => ({ ...m })); },
    async updateEach(list) {
      this.writes.push(list);
      rows = rows.map(m => { const w = list.find(x => x.phone === m.phone); return w ? { ...m, ...w.updates } : m; });
    },
  };
}

test('engine: first run marks silently with one summary; later payments ping per member', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsync-'));
  const store = fakeStore([
    { phone: '9000000001', name: 'A', status: 'ACTIVE', appPaidUntil: '', renewals: 0 },
    { phone: '9000000002', name: 'B', status: 'PENDING_APP', appPaidUntil: '', joinDate: ddmm(0) },
  ]);
  let answer = [row('9000000001', 30)];
  const client = { async memberships() { return { members: answer, truncated: false }; } };
  const pings = [];
  const sync = createAppSync({
    config: { botDir, app: {} }, log: { warn() {}, info() {} }, store, client,
    notify: async (t) => { pings.push(t); }, linksFor: async () => 'LINKS',
  });
  await sync.tick();
  assert.strictEqual(pings.length, 1);
  assert.match(pings[0], /App sync started — 1 member/);

  await sync.tick();
  assert.strictEqual(store.writes.length, 1, 'same expiry again writes nothing');

  answer = [row('9000000001', 60, { lastPaidAt: iso(0) }), row('9000000002', 30)];
  await sync.tick();
  assert.strictEqual(pings.length, 3);
  assert.match(pings[1], /App payment — A \(9000000001\) renewed/);
  assert.match(pings[2], /Paid on the app — B \(9000000002\), new member[\s\S]*LINKS/);
  assert.strictEqual(sync.snapshot().get('9000000002').status, 'active');
});

test('appClient: null without .env access; sends the token and unwraps the envelope', async () => {
  assert.strictEqual(createAppClient({ appSyncUrl: '', appSyncToken: 'x' }), null);
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, token: opts.headers['x-token'] };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { members: [] }, meta: { truncated: true } }) };
  };
  const c = createAppClient({ appSyncUrl: 'https://api.example.test/', appSyncToken: 'tok' }, fetchImpl);
  const out = await c.memberships({ phones: ['9000000001', '9000000002'] });
  assert.strictEqual(seen.url, 'https://api.example.test/api/v1/member-sync/memberships?phones=9000000001%2C9000000002');
  assert.strictEqual(seen.token, 'tok');
  assert.deepStrictEqual(out, { members: [], truncated: true });
  const bad = createAppClient({ appSyncUrl: 'https://x.test', appSyncToken: 't' },
    async () => ({ ok: false, status: 401, json: async () => ({ success: false, error: { code: 'AUTH_REQUIRED' } }) }));
  await assert.rejects(bad.memberships(), /HTTP 401 AUTH_REQUIRED/);
});

test('engine: onAppPaid gets every new app payment after the seed poll and takes over renewal pings', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsync-'));
  const store = fakeStore([{ phone: '9000000001', name: 'A', status: 'ACTIVE', appPaidUntil: ddmm(30), renewals: 1 }]);
  let answer = [row('9000000001', 30, { lastPaidAt: iso(-30) }), row('9000000009', 30, { lastPaidAt: iso(-30) })];
  const client = { async memberships() { return { members: answer, truncated: false }; } };
  const pings = [], paid = [];
  const sync = createAppSync({
    config: { botDir, app: {} }, log: { warn() {}, info() {} }, store, client,
    notify: async (t) => { pings.push(t); }, linksFor: async () => 'L', onAppPaid: async (rows) => { paid.push(...rows.map(r => r.phone)); },
  });
  await sync.tick();
  assert.deepStrictEqual(paid, [], 'the seed poll reports nothing');
  answer = [row('9000000001', 60, { lastPaidAt: iso(0) }), row('9000000009', 60, { lastPaidAt: iso(0) })];
  await sync.tick();
  assert.deepStrictEqual(paid, ['9000000001', '9000000009'], 'app-only payers included');
  assert.ok(!pings.some(p => /App payment/.test(p)), 'no duplicate own-sheet ping');
  assert.strictEqual(store.getAll()[0].billingDate, ddmm(60), 'the sheet is still renewed');
});
