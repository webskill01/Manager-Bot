import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../panel/routes.js';
import { openDb } from '../panel/lib/db.js';
import { buildPeople } from '../panel/lib/people.js';
import { hashPw } from '../panel/lib/auth.js';
import { formatDate } from '../core/globalConfig.js';

const day = (n) => formatDate(new Date(Date.now() + n * 86400e3));
const botCfg = { 'bot-abhi': { botName: 'bot-abhi', renewal: { fullAmount: 100, referralAmount: 100 }, removalDay: 7 } };
const people = buildPeople({
  sheets: { 'bot-abhi': [
    { name: 'Gurpreet', phone: '9876543210', status: 'ACTIVE', billingDate: day(-2), paidLast: 100 },
    { name: 'Harjit', phone: '9876543211', status: 'ACTIVE', billingDate: day(-1), paidLast: 100 },
    { name: 'Moved', phone: '9876543212', status: 'ACTIVE', billingDate: day(-1), paidLast: 100 },
  ] },
  app: [{ phone: '9876543212', status: 'active', paidCount: 1, lastAmount: 149, expiresAt: '2099-01-01T00:00:00.000Z' }],
});
const sync = { people: () => people, recheck: async (p) => people.get(p), refresh: async () => {}, status: () => ({ lastSync: 'x', bots: ['bot-abhi'], members: people.size }) };
const db = openDb(':memory:');
let server, base;

before(async () => {
  db.createUser({ name: 'Riya', role: 'caller', pwHash: hashPw('1234') });
  const app = createApp({ db, sync, botCfg, env: { adminName: 'Nitin', pin: 'first-pin-123', appPrice: 149 } });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const call = (path, { cookie, method = 'GET', body } = {}) => fetch(base + path, {
  method,
  headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }) },
  body: body && JSON.stringify(body),
});
async function login(name, password) {
  const res = await call('/login', { method: 'POST', body: { name, password } });
  assert.equal(res.status, 200, await res.clone().text());
  return { res, cookie: res.headers.get('set-cookie').split(';')[0] };
}

test('no cookie = 401', async () => {
  assert.equal((await call('/queue')).status, 401);
});

test('first admin logs in with the PIN; cookie is httpOnly, Secure, Lax', async () => {
  assert.equal((await call('/login', { method: 'POST', body: { name: 'Nitin', password: 'wrong-pin-00' } })).status, 401);
  const { res, cookie } = await login('Nitin', 'first-pin-123');
  const raw = res.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /Secure/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.equal((await res.json()).mustSetPassword, true);
  assert.equal((await call('/users', { cookie })).status, 200);
});

test('callers are kept out of admin routes', async () => {
  const { cookie } = await login('Riya', '1234');
  for (const [path, method, body] of [['/assign', 'POST', { phones: ['9876543210'], userId: 1 }], ['/users', 'GET'], ['/audit', 'GET'], ['/dashboard', 'GET']]) {
    assert.equal((await call(path, { cookie, method, body })).status, 403, path);
  }
});

test('form posts without JSON are refused', async () => {
  const res = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Nitin&password=x' });
  assert.equal(res.status, 415);
});

test('a logged call shows on the timeline and a promise blocks the queue row', async () => {
  const { cookie } = await login('Riya', '1234');
  const q1 = await (await call('/queue', { cookie })).json();
  assert.equal(q1.rows.length, 2, 'whoever moved to the app is parked');
  assert.equal(q1.rows[0].amount, 149);
  assert.equal(q1.kpis.onApp, 1);
  assert.deepEqual(await (await call('/person/9876543212/check', { cookie, method: 'POST', body: {} })).json(), { onApp: true, appState: 'member' });
  const dueAt = new Date(Date.now() + 2 * 86400e3).toISOString();
  const res = await call('/person/9876543210/interaction', { cookie, method: 'POST', body: { outcome: 'promise', note: 'pays Friday', dueAt, bot: 'bot-abhi' } });
  assert.equal(res.status, 200);
  const person = await (await call('/person/9876543210', { cookie })).json();
  assert.equal(person.timeline[0].note, 'pays Friday');
  assert.equal(person.followup.kind, 'promise');
  const q2 = await (await call('/queue', { cookie })).json();
  assert.equal(q2.rows.find(r => r.phone === '9876543210').blocked, 'promised');
});

test('focus serves the next unblocked person and claims them', async () => {
  const { cookie } = await login('Riya', '1234');
  const f = await (await call('/focus/next', { cookie })).json();
  assert.equal(f.row.phone, '9876543211');
  assert.equal(db.claims(new Date()).find(c => c.phone === '9876543211').user_id, db.userByName('Riya').id);
});

test('invite → join creates a caller who can log in', async () => {
  const { cookie } = await login('Nitin', 'first-pin-123');
  const { token } = await (await call('/invites', { cookie, method: 'POST', body: { role: 'caller' } })).json();
  const join = await call('/join', { method: 'POST', body: { token, name: 'Aman', password: '5678' } });
  assert.equal(join.status, 200);
  assert.equal((await call('/join', { method: 'POST', body: { token, name: 'Aman2', password: '5678' } })).status, 400, 'invite is single-use');
  await login('Aman', '5678');
});

test('PINs are 4 digits; admin resets a PIN; the recovery PIN forces a new one', async () => {
  const { cookie } = await login('Nitin', 'first-pin-123');
  assert.equal((await call('/password', { cookie, method: 'POST', body: { password: '12345' } })).status, 400);
  assert.equal((await call('/password', { cookie, method: 'POST', body: { password: '4321' } })).status, 200);
  await login('Nitin', '4321');
  const riya = db.userByName('Riya').id;
  assert.equal((await call(`/users/${riya}`, { cookie, method: 'PATCH', body: { pin: 'abcd' } })).status, 400);
  assert.equal((await call(`/users/${riya}`, { cookie, method: 'PATCH', body: { pin: '9999' } })).status, 200);
  await login('Riya', '9999');
  const again = await login('Nitin', 'first-pin-123');
  assert.equal((await again.res.json()).mustSetPassword, true, 'recovery clears the old PIN');
});

test('app filter narrows the queue; drawer and focus get the same person shape', async () => {
  const { cookie } = await login('Riya', '9999');
  const none = await (await call('/queue?app=none', { cookie })).json();
  assert.equal(none.rows.length, 2);
  assert.equal((await (await call('/queue?app=signed_up', { cookie })).json()).rows.length, 0);
  const p = await (await call('/person/9876543211', { cookie })).json();
  assert.equal(p.row.phone, '9876543211');
  assert.equal(p.appState, 'none');
  assert.equal(p.memberships[0].days, -1);
});
