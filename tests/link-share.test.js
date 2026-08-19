import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkBatches, renderTapLinks } from '../core/linkShare.js';

// Modelled on bot-nitin's real groups: city names and 22-character invite codes. A fixture
// with short names ("GROUP 1", "CODE1") makes the whole message ~590 chars, which fits under
// the Read more fold and would "prove" the split is unnecessary — a passing test asserting
// the opposite of production.
const CITIES = ['DELHI ONLY', 'CHANDIGARH ONLY', 'MOHALI ONLY', 'LUDHIANA ONLY',
  'AMRITSAR ONLY', 'JALANDHAR ONLY', 'PATIALA ONLY', 'BATHINDA ONLY',
  'MOGA ONLY', 'KHANNA ONLY', 'ZIRAKPUR ONLY', 'PANCHKULA ONLY'];
const links = CITIES.map((groupName, i) => ({
  groupName,
  link: `https://chat.whatsapp.com/${String.fromCharCode(65 + i).repeat(22)}`,
}));

test('12 links split into two batches of six', () => {
  const b = buildLinkBatches({ links, batchSize: 6 });
  assert.equal(b.length, 2);
  assert.ok(b[0].includes('DELHI ONLY'));
  assert.ok(b[0].includes('JALANDHAR ONLY'));
  assert.ok(b[1].includes('PATIALA ONLY'));
  assert.ok(!b[0].includes('PATIALA ONLY'));
});

test('no written numbering — WhatsApp adds its own', () => {
  // A line starting "7. PATIALA ONLY" is auto-formatted by WhatsApp as an ordered list item,
  // and it renders its own counter in front, so the operator saw "1. 7. PATIALA ONLY".
  const b = buildLinkBatches({ links, batchSize: 6 });
  assert.ok(b[1].includes('PATIALA ONLY'));
  assert.ok(!/^\s*\d+\.\s/m.test(b[0]), 'no batch line starts with a number and a dot');
  assert.ok(!/^\s*\d+\.\s/m.test(b[1]));
});

// The whole reason for splitting. WhatsApp collapses a message behind "Read more" at
// roughly 700-800 chars, and 12 links plus a greeting is ~880 — so a single message would
// hide most of the links from someone who has just paid.
test('each batch stays under the ~800 char Read more fold', () => {
  for (const part of buildLinkBatches({ links, batchSize: 6, greeting: 'Namaste Rajesh ji 🙏' })) {
    assert.ok(part.length < 800, `batch was ${part.length} chars`);
  }
});

test('all 12 in one message would NOT fit — proving the split earns its place', () => {
  const [single] = buildLinkBatches({ links, batchSize: 99, greeting: 'Namaste Rajesh ji 🙏' });
  assert.ok(single.length > 700, `one message is ${single.length} chars — under the fold, split unnecessary`);
});

test('three links make a single batch, no split', () => {
  assert.equal(buildLinkBatches({ links: links.slice(0, 3), batchSize: 6 }).length, 1);
});

test('the welcome message rides on the last batch', () => {
  const b = buildLinkBatches({ links, batchSize: 6, welcome: 'Welcome ji' });
  assert.ok(!b[0].includes('Welcome ji'));
  assert.ok(b[1].endsWith('Welcome ji'));
});

test('the greeting rides on the first batch', () => {
  const b = buildLinkBatches({ links, batchSize: 6, greeting: 'Namaste Rajesh ji' });
  assert.ok(b[0].startsWith('Namaste Rajesh ji'));
  assert.ok(!b[1].includes('Namaste Rajesh ji'));
});

test('no links yields no batches', () => {
  assert.deepEqual(buildLinkBatches({ links: [], batchSize: 6 }), []);
});

test('no links but a welcome still delivers the welcome', () => {
  assert.deepEqual(buildLinkBatches({ links: [], batchSize: 6, welcome: 'Hi' }), ['Hi']);
});

test('one batch renders as a single tap', () => {
  const out = renderTapLinks('9876543210', buildLinkBatches({ links: links.slice(0, 3), batchSize: 6 }), 3);
  assert.match(out, /1 tap/);
  assert.equal((out.match(/wa\.me/g) || []).length, 1);
});

test('two batches render as two taps, labelled by group range', () => {
  const out = renderTapLinks('9876543210', buildLinkBatches({ links, batchSize: 6 }), 12);
  assert.match(out, /2 taps/);
  assert.equal((out.match(/wa\.me/g) || []).length, 2);
  assert.match(out, /groups 1-6/);
  assert.match(out, /groups 7-12/);
});

test('the tap link carries the real message, url-encoded', () => {
  const out = renderTapLinks('9876543210', buildLinkBatches({ links: links.slice(0, 2), batchSize: 6 }), 2);
  const url = out.match(/https:\/\/wa\.me\/\S+/)[0];
  assert.ok(url.startsWith('https://wa.me/919876543210?text='));
  const text = decodeURIComponent(url.split('?text=')[1]);
  assert.ok(text.includes('https://chat.whatsapp.com/AAAAAAAAAAAAAAAAAAAAAA'));
  assert.ok(text.includes('CHANDIGARH ONLY'));
});

test('an uneven final batch is labelled with the real range', () => {
  // 7 links at 6 per batch → 1-6 then a lone 7-7, not "7-12".
  const seven = links.slice(0, 7);
  const out = renderTapLinks('9876543210', buildLinkBatches({ links: seven, batchSize: 6 }), 7);
  assert.match(out, /groups 7-7/);
});

test('nothing to send says so rather than rendering an empty tap', () => {
  assert.match(renderTapLinks('9876543210', [], 0), /No group links/);
});
