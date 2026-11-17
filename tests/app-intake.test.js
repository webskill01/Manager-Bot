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
