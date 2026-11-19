import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, contactName, tagFor, firstName } from '../core/appIntake.js';

test('template: Hinglish, Punjabi, Hindi, no name; normal chat ignored', () => {
  assert.deepEqual(parseTemplate('Hi, maine PUNJAB TAXI & EASECAB WhatsApp group mein join request bhej di hai. Kindly meri request approve kar do.\nName: Yatin Sadana\nNumber: 7354000013'),
    { name: 'Yatin Sadana', phone: '7354000013' });
  assert.deepEqual(parseTemplate('ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ PUNJAB TAXI & EASECAB ਵਟਸਐਪ ਗਰੁੱਪ ਵਿੱਚ ਜੁਆਇਨ ਰਿਕਵੈਸਟ ਭੇਜ ਦਿੱਤੀ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਮੇਰੀ ਰਿਕਵੈਸਟ ਮਨਜ਼ੂਰ ਕਰੋ।\nਨਾਮ: Suba singh\nਨੰਬਰ: 9417145405 '),
    { name: 'Suba singh', phone: '9417145405' });
  assert.deepEqual(parseTemplate('नमस्ते\nनाम: Raj\nनंबर: +91 98765-43210'), { name: 'Raj', phone: '9876543210' });
  assert.deepEqual(parseTemplate('Kindly approve.\nName: \nNumber: 9876543210'), { name: '', phone: '9876543210' });
  assert.equal(parseTemplate('ok ji, my number is 9876543210'), null);
  assert.equal(parseTemplate('Number: 12345'), null);
});

test('contact name: app expiry day + EC, ST tag for bot-abhi users', () => {
  assert.equal(contactName('Yatin Sadana', '2026-12-16T10:00:00+05:30'), 'Yatin Sadana - 16 EC');
  assert.equal(contactName('Suba singh', '2026-12-05T10:00:00+05:30', 'ST'), 'Suba singh - 05 EC ST');
});

test('intake command: one per line, name optional, spaced numbers ok, junk skipped', async () => {
  const { createAppIntake } = await import('../core/appIntake.js');
  const seen = [];
  const intake = createAppIntake({
    config: { botDir: '.', botName: 'bot-nitin' }, log: { warn() {}, info() {} }, getSock: () => null,
    appSync: { lookup: async (p) => { seen.push(p); return null; } }, fleet: null, store: null, notify: async () => {},
  });
  const out = await intake.manual(' 9876543210 Gurpreet Singh\n98765 43211\nhello\n+91 9876543212 Raj');
  assert.deepEqual(seen, ['9876543210', '9876543211', '9876543212']);
  assert.match(out, /Gurpreet \(9876543210\) — \*not paid/);
  assert.match(await intake.manual(''), /^Format/);
});

test('tag: only when unique to abhi (ST) / sachin (MT); a row added by intake is not "own"', () => {
  const tags = { 'bot-abhi': 'ST', 'bot-sachin2': 'MT' };
  const on = (...bots) => bots.map(bot => ({ bot, member: {} }));
  assert.equal(tagFor(on('bot-abhi'), 'bot-nitin', tags), 'ST');
  assert.equal(tagFor(on('bot-sachin2'), 'bot-nitin', tags), 'MT');
  assert.equal(tagFor(on('bot-nitin', 'bot-abhi'), 'bot-nitin', tags), '');
  assert.equal(tagFor(on('bot-nitin', 'bot-abhi'), 'bot-nitin', tags, true), 'ST');
  assert.equal(tagFor(on('bot-aayush2'), 'bot-nitin', tags), '');
});

test('first name: first word, letters only, capitalised; emoji-only → empty', () => {
  assert.equal(firstName('gursewak singh'), 'Gursewak');
  assert.equal(firstName('Waheguruji 🙏'), 'Waheguruji');
  assert.equal(firstName('batrasaab898'), 'Batrasaab');
  assert.equal(firstName('🙏🙏'), '');
  assert.equal(firstName('ਗੁਰਸੇਵਕ ਸਿੰਘ'), 'ਗੁਰਸੇਵਕ');
});

test('intake name: app name beats the template name', async () => {
  const { createAppIntake } = await import('../core/appIntake.js');
  const intake = createAppIntake({
    config: { botDir: '.', botName: 'bot-nitin' }, log: { warn() {}, info() {} }, getSock: () => null,
    appSync: { lookup: async () => ({ name: 'harpreet kaur' }) }, fleet: null, store: null, notify: async () => {},
  });
  assert.match(await intake.manual('9876543210 Sweety'), /^📥 Harpreet \(9876543210\)/);
});

test('auto intake: on no sheet → null (left for the template)', async () => {
  const { createAppIntake } = await import('../core/appIntake.js');
  const intake = createAppIntake({
    config: { botDir: '.', botName: 'bot-nitin' }, log: { warn() {}, info() {} }, getSock: () => null,
    appSync: { lookup: async () => null }, fleet: { whereIs: async () => [] }, store: null, notify: async () => {},
  });
  assert.equal(await intake.auto('9876543210'), null);
});

test('auto intake: on no sheet but app has a name → intaken', async () => {
  const { createAppIntake } = await import('../core/appIntake.js');
  const row = { name: 'jaswant singh', paidCount: 1, status: 'active', lastPaidAt: '2026-11-10T00:00:00Z', expiresAt: new Date(Date.now() + 9 * 864e5).toISOString() };
  const added = [];
  const intake = createAppIntake({
    config: { botDir: '.', botName: 'bot-nitin' }, log: { warn() {}, info() {} }, getSock: () => null,
    appSync: { lookup: async () => row }, fleet: { whereIs: async () => [] },
    store: { add: async (m) => added.push(m.name) }, notify: async () => {},
  });
  assert.match(await intake.auto('9876543210'), /Jaswant \(9876543210\) · live on app/);
  assert.deepEqual(added, ['Jaswant']);
});

test('link reply: link on its own line, name in the opener, varies between sends', async () => {
  const { linkReply } = await import('../core/appIntake.js');
  const outs = new Set(Array.from({ length: 30 }, () => linkReply('Amit', 'https://chat.whatsapp.com/X')));
  for (const t of outs) { assert.match(t, /Amit/); assert.ok(t.split('\n').includes('https://chat.whatsapp.com/X')); }
  assert.ok(outs.size > 5);
  assert.doesNotMatch(linkReply('', 'L'), /\{n\}|  /);
});

test('paid within a day of a kick → app group link DMed once', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { createAppIntake } = await import('../core/appIntake.js');
  const { loadKicked, saveKicked } = await import('../core/removalEngine.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-'));
  saveKicked(dir, { '7973855083': new Date().toISOString(), '9000000000': new Date(Date.now() - 1.5 * 864e5).toISOString() });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const sock = { sendMessage: async (jid, m) => sent.push([jid, m.text]), addOrEditContact: async () => {} };
  const intake = createAppIntake({
    config: { botDir: dir, botName: 'bot-nitin', appGroupLink: 'https://chat.whatsapp.com/X' }, log: { warn() {}, info() {} },
    getSock: () => sock, appSync: null, fleet: null, store: null, notify: async () => {},
  });
  const row = { phone: '7973855083', name: 'harbhajan singh', paidCount: 2, status: 'active', lastPaidAt: '2026-11-19T04:02:14Z', expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() };
  await intake.onPaid([row, { ...row, phone: '9000000000' }]);
  t.mock.timers.tick(300_001);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], '917973855083@s.whatsapp.net');
  assert.match(sent[0][1], /Harbhajan[\s\S]*chat\.whatsapp\.com\/X/);
  assert.deepEqual(Object.keys(loadKicked(dir)), ['9000000000']);
});

test('applink saves the contact on the WhatsApp number when the app number is paid', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { createAppIntake } = await import('../core/appIntake.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
  const row = { name: 'tejpal singh', paidCount: 1, status: 'active', lastPaidAt: '2026-11-10T00:00:00Z', expiresAt: '2026-12-10T10:00:00+05:30' };
  const saved = []; const notes = [];
  const intake = createAppIntake({
    config: { botDir: dir, botName: 'bot-nitin' }, log: { warn() {}, info() {} },
    getSock: () => ({ addOrEditContact: async (jid, c) => saved.push([jid, c.fullName]) }),
    appSync: { lookup: async (p) => (p === '9814918249' ? row : null) },
    fleet: { whereIs: async () => [{ bot: 'bot-nitin', member: { name: 'Tejpal', status: 'ACTIVE' } }] },
    store: { add: async () => {} }, notify: async (t) => notes.push(t),
  });
  intake.link('7710121213', '9814918249');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(saved, [['917710121213@s.whatsapp.net', 'Tejpal - 10 EC']]);
  assert.match(notes[0], /Tejpal \(9814918249\)/);
  assert.equal(intake.appPhoneOf('7710121213'), '9814918249');
});
