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

test('numbering runs 1-12 across batches, not 1-6 twice', () => {
  const b = buildLinkBatches({ links, batchSize: 6 });
  assert.ok(b[0].includes('1. DELHI ONLY'));
  assert.ok(b[1].includes('7. PATIALA ONLY'));
  assert.ok(!b[1].includes('1. PATIALA ONLY'), 'the second batch must not restart at 1');
});

test("a group whose own name starts with a number is not numbered twice", () => {
  // nitin's real WhatsApp subjects are "6.LUDHIANA ONLY (Punjab Taxi Group)". Prefixing the
  // position onto that produced "6. 6.LUDHIANA ONLY" in every link message the operator sent.
  const named = [
    { groupName: '1.PUNJAB TAXI (Mix Duty)', link: 'https://chat.whatsapp.com/AAAA' },
    { groupName: '6.LUDHIANA ONLY (Punjab Taxi Group)', link: 'https://chat.whatsapp.com/BBBB' },
    { groupName: '12) GURGAON ONLY', link: 'https://chat.whatsapp.com/CCCC' },
  ];
  const [batch] = buildLinkBatches({ links: named, batchSize: 6 });
  assert.ok(batch.includes('1. PUNJAB TAXI (Mix Duty)'), batch);
  assert.ok(batch.includes('2. LUDHIANA ONLY (Punjab Taxi Group)'), batch);
  assert.ok(batch.includes('3. GURGAON ONLY'), batch);
  assert.ok(!/\d+\.\s*\d+[.)]/.test(batch), `doubled numbering in:
${batch}`);
});

test('a name that merely begins with digits keeps them', () => {
  const [batch] = buildLinkBatches({
    links: [{ groupName: '24x7 DUTY GROUP', link: 'https://chat.whatsapp.com/AAAA' }],
  });
  assert.ok(batch.includes('1. 24x7 DUTY GROUP'), batch);
});

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
