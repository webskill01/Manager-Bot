import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandParser, sheetsHint } from '../core/commandParser.js';

// bot-abhi's sheet went read-only because the Drive account owning it ran out of storage,
// so every write 403'd with "The caller does not have permission" (the API reports that
// identically to a Viewer-only share, which is why the hint names both). Reads worked, so
// the bot looked healthy — and the operator got NO reply at all, because the switch in
// parse() returns the handler's promise instead of awaiting it, letting the rejection skip
// the catch. These pin both halves: the operator always gets an answer, and it names the cause.

const log = { info() {}, warn() {}, error() {} };

function denyingStore() {
  const boom = () => {
    const err = new Error('The caller does not have permission');
    err.code = 403;
    return Promise.reject(err);
  };
  return {
    getAll: () => [],
    getActive: () => [],
    findByPhone: () => null,
    async refresh() {},
    add: boom,
    update: boom,
  };
}

const config = {
  botDir: '.',
  botName: 'bot-test',
  profile: 'tracker',
  paidGroups: ['g1@g.us'],
  joining: { fee: 100 },
  renewal: { fullAmount: 100, referralAmount: 100 },
  overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  messages: {},
  rateLimits: {},
};

const parser = () => createCommandParser(
  denyingStore(),
  { async addToAllGroups() { return { added: [], failed: [] }; }, async sendToMember() { return true; } },
  config, log, { user: {} }, Date.now(), {}, {}, {}, new Set(), null, null,
);

test('a sheet write denial replies to the operator instead of escaping silently', async () => {
  for (const cmd of ['addsilent Pardeep 8591190011', 'add Rajan 9876500001']) {
    const out = await parser().parse(cmd);
    assert.ok(typeof out === 'string' && out.length > 0, `${cmd} must return a reply, not throw`);
    assert.match(out, /Error processing command/, `${cmd} reports the failure`);
    assert.match(out, /READ-ONLY for this bot/, `${cmd} names the sheet as the problem`);
    assert.match(out, /out of storage/, `${cmd} names the storage-full cause`);
  }
});

test('sheetsHint fires on a Sheets 403 and stays quiet on everything else', () => {
  for (const err of [
    { code: 403, message: 'The caller does not have permission' },
    { message: 'The caller does not have permission' },
    { response: { status: 403 }, message: 'Request had insufficient authentication scopes' },
  ]) {
    const hint = sheetsHint(err);
    assert.match(hint, /out of storage/);
    assert.match(hint, /Viewer instead of Editor/);
  }
  assert.equal(sheetsHint({ code: 429, message: 'Quota exceeded' }), '');
  assert.equal(sheetsHint(new Error('Member not found: 9876500001')), '');
});
