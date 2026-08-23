import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapToCopy } from '../core/telegramTransport.js';

test('a phone number becomes tappable-to-copy', () => {
  assert.equal(tapToCopy('   • Rajan  9855112233'), '   • Rajan  <code>9855112233</code>');
});

test('a wa.me link is left alone — wrapping the 91… inside it would break the link', () => {
  const link = 'https://wa.me/919855112233?text=hi';
  assert.equal(tapToCopy(`  1. Rajan\n${link}`), `  1. Rajan\n${link}`);
});

test('a JID is left alone', () => {
  assert.equal(tapToCopy('9855112233@s.whatsapp.net'), '9855112233@s.whatsapp.net');
});

test('fees, dates and counts are not numbers anyone copies', () => {
  assert.equal(tapToCopy('₹90 · 23-08-2026 · 5d overdue · 12 groups'),
    '₹90 · 23-08-2026 · 5d overdue · 12 groups');
});

test('HTML in a group name is escaped, never sent raw', () => {
  // Telegram rejects the WHOLE message on malformed HTML — the operator would see nothing.
  assert.equal(tapToCopy('SINGH & SONS <PAID>'), 'SINGH &amp; SONS &lt;PAID&gt;');
});

test('*bold* still renders literally, exactly as it did with no parse_mode', () => {
  assert.equal(tapToCopy('*DM LIST*'), '*DM LIST*');
});
