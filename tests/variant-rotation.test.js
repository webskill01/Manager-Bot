import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVariant } from '../core/globalConfig.js';
import { buildDmList } from '../core/dmList.js';

test('a sequence rotates round robin instead of hashing', () => {
  const v = ['a', 'b', 'c'];
  const got = [0, 1, 2, 3, 4, 5].map(i => pickVariant(v, '9876543210', '2026-08-18', i));
  assert.deepEqual(got, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('no two neighbours on a list share a wording', () => {
  const cfg = {
    joining: { fee: 90 },
    overdue: { autoReminderDays: 5, finalReminderDays: 6 },
    messages: { reminder: ['A {name}', 'B {name}', 'C {name}'] },
  };
  const d = new Date();
  const billingDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const members = Array.from({ length: 12 }, (_, i) => ({
    name: `M${i}`, phone: `90000000${String(i).padStart(2, '0')}`,
    billingDate, status: 'ACTIVE', renewals: 0,
  }));
  const { rows } = buildDmList({ members, config: cfg, cohort: 'due' });
  assert.equal(rows.length, 12);
  const letters = rows.map(r => r.text[0]);
  for (let i = 1; i < letters.length; i++) {
    assert.notEqual(letters[i], letters[i - 1], `rows ${i - 1} and ${i} both got wording ${letters[i]}`);
  }
});
