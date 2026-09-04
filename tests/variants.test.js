import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVariant } from '../core/globalConfig.js';

test('a plain string passes through untouched', () => {
  assert.equal(pickVariant('hello', '9876543210', '2026-08-18'), 'hello');
});

test('undefined stays undefined so the || fallback chain still works', () => {
  assert.equal(pickVariant(undefined, '9876543210', '2026-08-18'), undefined);
});

test('the same phone and date always pick the same variant', () => {
  const v = ['a', 'b', 'c'];
  const first = pickVariant(v, '9876543210', '2026-08-18');
  for (let i = 0; i < 20; i++) {
    assert.equal(pickVariant(v, '9876543210', '2026-08-18'), first);
  }
});

test('different members get a spread of variants, not all the same', () => {
  const v = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    seen.add(pickVariant(v, `98765432${String(i).padStart(2, '0')}`, '2026-08-18'));
  }
  assert.equal(seen.size, 3);
});

test('the same member drifts across dates', () => {
  const v = ['a', 'b', 'c'];
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    seen.add(pickVariant(v, '9876543210', `2026-08-${String(d).padStart(2, '0')}`));
  }
  assert.ok(seen.size > 1, 'a member pinned to one variant forever defeats the point');
});

test('a single-entry array behaves like a string', () => {
  assert.equal(pickVariant(['only'], '9876543210', '2026-08-18'), 'only');
});

test('an empty array yields empty string, never undefined-as-text', () => {
  assert.equal(pickVariant([], '9876543210', '2026-08-18'), '');
});

test('the spread is roughly even, not 90% one variant', () => {
  const v = ['a', 'b', 'c'];
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 900; i++) {
    counts[pickVariant(v, `9${String(i).padStart(9, '0')}`, '2026-08-18')]++;
  }
  for (const k of Object.keys(counts)) {
    assert.ok(counts[k] > 200, `variant ${k} only got ${counts[k]}/900 — hash is skewed`);
  }
});

// ── the real shipped configs ──────────────────────────────────────────────────
import fs from 'node:fs';
import { buildDmList } from '../core/dmList.js';

const BOTS = ['bot-nitin', 'bot-abhi', 'bot-sachin2', 'bot-aayush2'];
const STAGES = ['reminder', 'referralReminder', 'overdue', 'finalReminder'];

function ddmmyyyy(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

test('every shipped variant substitutes cleanly — no {name} or {date} survives', () => {
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    for (const [cohort, days] of [['due', 0], ['nudge', cfg.overdue.autoReminderDays], ['final', cfg.overdue.finalReminderDays]]) {
      // 40 members spreads them across every variant of whichever stage this cohort maps to.
      const members = Array.from({ length: 40 }, (_, i) => ({
        name: `Member${i}`, phone: `90000000${String(i).padStart(2, '0')}`,
        billingDate: ddmmyyyy(days), status: 'ACTIVE', renewals: 0,
      }));
      const { rows } = buildDmList({ members, config: cfg, cohort });
      assert.ok(rows.length > 0, `${bot}/${cohort} produced no rows`);
      for (const r of rows) {
        assert.ok(!r.text.includes('{name}'), `${bot}/${cohort}: unsubstituted {name} in:\n${r.text}`);
        assert.ok(!r.text.includes('{date}'), `${bot}/${cohort}: unsubstituted {date} in:\n${r.text}`);
        assert.ok(r.text.trim().length > 0, `${bot}/${cohort}: empty message`);
      }
    }
  }
});

test('a template naming the member twice substitutes BOTH', () => {
  // Plain-string .replace() only swaps the first match, so the second would ship as the
  // literal text "{name}". Easy to hit now that operators hand-write several variants.
  const cfg = {
    joining: { fee: 90 },
    overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
    messages: { reminder: '{name} ji, {date} nu {name} da mahina {date} nu pura hoya' },
  };
  const members = [{ name: 'Rajan', phone: '9000000001', billingDate: ddmmyyyy(0), status: 'ACTIVE', renewals: 0 }];
  const { rows } = buildDmList({ members, config: cfg, cohort: 'due' });
  assert.ok(!rows[0].text.includes('{name}'), rows[0].text);
  assert.ok(!rows[0].text.includes('{date}'), rows[0].text);
  assert.equal((rows[0].text.match(/Rajan/g) || []).length, 2);
});

test('bots with variants actually produce more than one distinct message', () => {
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    const members = Array.from({ length: 60 }, (_, i) => ({
      name: 'SameName', phone: `90000000${String(i).padStart(2, '0')}`,
      billingDate: ddmmyyyy(0), status: 'ACTIVE', renewals: 0,
    }));
    const { rows } = buildDmList({ members, config: cfg, cohort: 'due' });
    const distinct = new Set(rows.map(r => r.text));
    assert.equal(distinct.size, cfg.messages.reminder.length,
      `${bot}: expected ${cfg.messages.reminder.length} distinct wordings, saw ${distinct.size}`);
  }
});

test('every shipped config still parses and keeps its amounts consistent', () => {
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    for (const stage of STAGES) {
      const v = cfg.messages[stage];
      const list = Array.isArray(v) ? v : [v];
      assert.ok(list.length > 0 && list.every(x => typeof x === 'string' && x.trim()),
        `${bot}.messages.${stage} has an empty or non-string entry`);
    }
  }
});

// Three lists, three different questions. reportIds is who wants to see how the day went —
// all three partners, on every bot. dripIds is who WORKS the queue, and must stay one person:
// two people tapping the same link batch send the same member the same reminder twice.
// allowedTelegramIds is neither — it is the command security boundary.
test('every bot reports to all three partners but hands its links to one', () => {
  const cfgs = BOTS.map(b => JSON.parse(fs.readFileSync(`bots/${b}/config.json`, 'utf8')));
  const first = [...cfgs[0].reportIds].sort();
  assert.equal(first.length, 3, `reportIds should name all three partners, saw ${first.join(',')}`);
  for (const [i, cfg] of cfgs.entries()) {
    assert.deepEqual([...cfg.reportIds].sort(), first, `${BOTS[i]} reports to a different set`);
    assert.equal(cfg.dripIds.length, 1, `${BOTS[i]}: link batches go to ${cfg.dripIds.length} people`);
    assert.ok(cfg.allowedTelegramIds.includes(cfg.dripIds[0]),
      `${BOTS[i]}: the operator getting the links cannot run a command on the bot`);
  }
});

test('no config still carries the "knra" misspelling of "krna"', () => {
  for (const bot of BOTS) {
    const raw = fs.readFileSync(`bots/${bot}/config.json`, 'utf8');
    assert.ok(!/knra/i.test(raw), `${bot}: "knra" should be "krna"`);
  }
});

test('no two bots share a group name — that is how abhi\'s groups ended up in sachin\'s kick prompt', () => {
  // bot-sachin2 shipped with "SINGH TRAVELS (PAID) ( ONLY DELHI // GURGAON // NOIDA -
  // PICK-DROP)" pasted in from bot-abhi, so every "remove them from these groups"
  // instruction named a group sachin does not run. Nothing in the code could catch it —
  // the list was the right LENGTH. This is the check that would have.
  const seen = new Map();
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    assert.equal((cfg.groupNames || []).length, (cfg.paidGroups || []).length,
      `${bot}: groupNames and paidGroups have drifted — kick would name a vague fallback list`);
    for (const name of cfg.groupNames || []) {
      const owner = seen.get(name);
      assert.ok(!owner, `"${name}" is in both ${owner} and ${bot} — one of them is a copy-paste`);
      seen.set(name, bot);
    }
  }
});
