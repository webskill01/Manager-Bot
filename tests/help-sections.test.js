import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HELP_CATEGORIES, categoriesFor, bodiesFor, renderHelp } from '../core/helpText.js';
import { followUps } from '../core/telegramTransport.js';

const cfg = (over = {}) => ({
  renewal: { fullAmount: 90, referralAmount: 45 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6 },
  joining: { fee: 90 },
  tracker: { callAfterDays: 30, followUpDays: 3 },
  ...over,
});
const FULL = cfg({ profile: 'full' });
const TRACKER = cfg({ profile: 'tracker', transport: 'telegram' });

// A whole-word match. Built from a regex literal source rather than an escaped string —
// "\\b" written into a template literal collapses to a backspace character, which silently
// matches nothing and turns doesNotMatch into a test that can never fail.
const word = (w) => new RegExp(/\b/.source + w + /\b/.source);

test('every category has a body, and every body has a category', () => {
  // A category with no body is a button that answers `undefined`; a body with no category is
  // a section nobody can reach.
  for (const config of [FULL, TRACKER]) {
    const keys = categoriesFor(config).map(([k]) => k);
    const bodies = Object.keys(bodiesFor(config));
    assert.deepEqual([...keys].sort(), [...bodies].sort(), `${config.profile} categories and bodies differ`);
    for (const key of keys) {
      assert.ok(renderHelp(config, key).trim().length > 20, `${config.profile}/${key} is empty`);
    }
  }
});

test('every help button points at a section that exists', () => {
  for (const profile of ['full', 'tracker']) {
    const rows = followUps('help', profile);
    assert.ok(rows, `${profile}: help has no buttons`);
    const keys = new Set(HELP_CATEGORIES[profile].map(([k]) => k));
    for (const [data, label] of rows.flat()) {
      assert.match(data, /^help (\w+|all)$/, `bad callback_data "${data}"`);
      const arg = data.split(' ')[1];
      assert.ok(arg === 'all' || keys.has(arg), `${profile}: button "${label}" → unknown section "${arg}"`);
      assert.ok(Buffer.byteLength(data) <= 64);
    }
    assert.ok(rows.flat().some(([d]) => d === 'help all'), `${profile}: no escape hatch to the full list`);
  }
});

test('a tracker bot gets tracker sections, not the full ones', () => {
  const tracker = followUps('help', 'tracker').flat().map(([d]) => d);
  assert.ok(tracker.includes('help calling'), 'the call funnel is the point of a tracker bot');
  assert.ok(!tracker.includes('help renewals'), 'a tracker bot collects no renewals');
});

test('help all still carries the whole inventory, with its title', () => {
  const all = renderHelp(FULL, 'all');
  assert.match(all, /📋 BOT COMMANDS/);
  for (const cmd of ['dmlist', 'renewed', 'kickghosts', 'growth', 'audit', 'tenure', 'norenew', 'refreshlinks']) {
    assert.match(all, word(cmd), `help all lost ${cmd}`);
  }
  assert.match(renderHelp(TRACKER, 'all'), /📋 BOT COMMANDS — tracker/);
});

test('help all does not advertise retired commands', () => {
  const all = renderHelp(FULL, 'all');
  for (const dead of ['addnew', 'remindall', 'catchup', 'moved']) {
    assert.doesNotMatch(all, word(dead), `${dead} is retired but still documented`);
  }
});

test('the bare index lists every section and stays short', () => {
  const idx = renderHelp(FULL);
  for (const [, label] of HELP_CATEGORIES.full) assert.ok(idx.includes(label), `index missing ${label}`);
  // The whole point: it must fit on a phone screen without scrolling past it.
  assert.ok(idx.split('\n').length < 20, `index is ${idx.split('\n').length} lines — that is a wall again`);
  assert.ok(idx.length < renderHelp(FULL, 'all').length / 4);
});

test('a section name matches on prefix, and a wrong one lands on the index', () => {
  assert.equal(renderHelp(FULL, 'rem'), renderHelp(FULL, 'reminders'));
  assert.equal(renderHelp(FULL, 'REPORTS'), renderHelp(FULL, 'reports'));
  const miss = renderHelp(FULL, 'zzz');
  assert.match(miss, /No help section called "zzz"/);
  assert.match(miss, /👤 Members/, 'a miss must still show the way out');
});

test('the index needs no monospace font to read', () => {
  // Telegram renders message text proportionally, so any padEnd alignment is a lie.
  for (const line of renderHelp(FULL).split('\n')) {
    assert.doesNotMatch(line, /\S {3,}\S/, `"${line}" relies on column padding`);
  }
});

test('every command named in the help is one the parser knows', () => {
  const parser = fs.readFileSync('core/commandParser.js', 'utf8');
  const all = renderHelp(FULL, 'all');
  // The leading token of each bullet is the command it documents.
  const named = new Set([...all.matchAll(/^• ([a-z][a-z0-9]*)\b/gm)].map(m => m[1]));
  for (const cmd of named) {
    assert.ok(parser.includes(`case '${cmd}'`), `help documents "${cmd}" but the parser has no case for it`);
  }
  assert.ok(named.size > 25, `only found ${named.size} commands — the regex stopped matching`);
});
