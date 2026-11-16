import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, contactName } from '../core/appIntake.js';

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
