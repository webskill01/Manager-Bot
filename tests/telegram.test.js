import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createManualGroupManager, parseGroupLink, waMeLink, NoGroupAccessError,
} from '../core/manualGroupManager.js';
import { createMemberHandlers } from '../core/handlers/memberHandlers.js';
import { createCommandParser } from '../core/commandParser.js';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';

const log = { info() {}, warn() {}, error() {} };

const GROUP_LINKS = [
  '1. SINGH TRAVELS (PAID) (DELHI):\n https://chat.whatsapp.com/AAA111',
  '2. SINGH TRAVELS (PAID) (MOHALI):\n https://chat.whatsapp.com/BBB222',
];

const tgConfig = (extra = {}) => ({
  botDir: '.',
  botName: 'bot-test',
  profile: 'tracker',
  transport: 'telegram',
  paidGroups: ['g1@g.us', 'g2@g.us'],
  groupLinks: GROUP_LINKS,
  welcomeMessage: 'Welcome {name} ji',
  joining: { fee: 100 },
  renewal: { fullAmount: 100, referralAmount: 100 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6 },
  tracker: { callAfterDays: 30, followUpDays: 3 },
  messages: { reminder: 'r', overdue: 'o', finalReminder: 'f' },
  ...extra,
});

function fakeStore(members = []) {
  const rows = members.map(m => ({ ...m }));
  const added = [];
  const writes = [];
  return {
    rows, added, writes,
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    findByName: () => [],
    async refresh() {},
    async add(m) { rows.push({ ...m, status: m.status || 'ACTIVE' }); added.push(m); return m; },
    async update(phone, updates) {
      const row = rows.find(m => m.phone === phone);
      if (!row) throw new Error(`Member not found: ${phone}`);
      Object.assign(row, updates);
      writes.push({ phone, updates });
      return { ...row };
    },
  };
}

// ── wa.me link building ───────────────────────────────────────────────────────

test('waMeLink adds the 91 country code to a 10-digit number and encodes the text', () => {
  const link = waMeLink('9855112233', 'hi there & bye');
  assert.equal(link, 'https://wa.me/919855112233?text=hi%20there%20%26%20bye');
});

test('waMeLink leaves an already-international number alone', () => {
  assert.match(waMeLink('919855112233', 'x'), /^https:\/\/wa\.me\/919855112233\?/);
});

test('waMeLink encodes newlines so multi-line onboarding text survives the URL', () => {
  const link = waMeLink('9855112233', 'line1\nline2');
  assert.ok(link.includes('line1%0Aline2'), `newline not encoded: ${link}`);
  assert.ok(!link.includes('\n'), 'raw newline leaked into the URL');
});

test('parseGroupLink splits the label off the URL', () => {
  const p = parseGroupLink(GROUP_LINKS[0], 0);
  assert.equal(p.groupName, '1. SINGH TRAVELS (PAID) (DELHI)');
  assert.equal(p.link, 'https://chat.whatsapp.com/AAA111');
});

test('parseGroupLink falls back to a positional name when the entry has no URL', () => {
  assert.deepEqual(parseGroupLink('', 4), { groupId: null, groupName: 'Group 5', link: '' });
});

// ── manual group manager ──────────────────────────────────────────────────────

test('sendToMember reports zero sent and hands back a tap-to-send link', async () => {
  const gm = createManualGroupManager(tgConfig(), log);
  const res = await gm.sendToMember('9855112233', ['link one', 'welcome']);
  assert.equal(res.sent, 0);
  assert.equal(res.failed, 0);
  assert.ok(res.manual.includes('https://wa.me/919855112233?text='));
  // Both parts of the onboarding sequence must be inside the pre-filled text.
  assert.ok(res.manual.includes(encodeURIComponent('link one')));
  assert.ok(res.manual.includes(encodeURIComponent('welcome')));
});

test('removeFromAllGroups removes nobody and names the groups to clear by hand', async () => {
  const gm = createManualGroupManager(tgConfig(), log);
  const res = await gm.removeFromAllGroups('9855112233');
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.failed, []);
  assert.ok(res.manual.includes('9855112233'));
  assert.ok(res.manual.includes('SINGH TRAVELS (PAID) (DELHI)'));
  assert.ok(res.manual.includes('SINGH TRAVELS (PAID) (MOHALI)'));
});

test('kick instructions fall back to group JIDs when no groupLinks are configured', async () => {
  const gm = createManualGroupManager(tgConfig({ groupLinks: [] }), log);
  const res = await gm.removeFromAllGroups('9855112233');
  assert.ok(res.manual.includes('Group 1'));
  assert.ok(res.manual.includes('Group 2'));
});

test('kick names ALL paid groups even when groupLinks is short of them', async () => {
  // 3 paid groups but only 2 links configured. Naming the 2 would leave the member
  // sitting in the third paid group with the operator believing they were cleared.
  const cfg = tgConfig({ paidGroups: ['g1@g.us', 'g2@g.us', 'g3@g.us'] });
  const gm = createManualGroupManager(cfg, log);
  const res = await gm.removeFromAllGroups('9855112233');
  assert.ok(res.manual.includes('3 group(s)'), `undercounted groups:\n${res.manual}`);
  assert.equal((res.manual.match(/•/g) || []).length, 3, 'not every paid group was listed');
});

test('commands needing live group state throw rather than reporting a false zero', async () => {
  const gm = createManualGroupManager(tgConfig(), log);
  for (const fn of ['checkMembership', 'getAllPendingRequests', 'approveAllPendingRequests',
                    'rejectAllPendingRequests', 'approveByPhone', 'rejectByPhone']) {
    await assert.rejects(() => gm[fn]('9855112233'), NoGroupAccessError, `${fn} should refuse`);
  }
});

test('manual manager exposes the same method set as the live one', async () => {
  const { createGroupManager } = await import('../core/groupManager.js');
  // createGroupManager reads rateLimits at construction; the live socket is never touched.
  const cfg = tgConfig({ rateLimits: { batchCooldownMs: 1, groupOpGapMinMs: 1, groupOpGapMaxMs: 2 } });
  const live = createGroupManager({}, cfg, log);
  const manual = createManualGroupManager(cfg, log);
  for (const k of Object.keys(live)) {
    assert.equal(typeof manual[k], 'function', `manual manager is missing ${k}()`);
  }
});

// ── handler wiring ────────────────────────────────────────────────────────────

test('add writes the sheet row and never claims messages were sent', async () => {
  const store = fakeStore();
  const gm = createManualGroupManager(tgConfig(), log);
  const h = createMemberHandlers(store, gm, tgConfig(), log);

  const reply = await h.handleAdd(['Raju', '9855112233', '15']);

  assert.equal(store.added.length, 1, 'sheet row was not written');
  assert.equal(store.added[0].phone, '9855112233');
  assert.ok(reply.includes('added to sheet'));
  assert.ok(reply.includes('https://wa.me/919855112233'));
  assert.ok(!/Sent \d+\/\d+ messages/.test(reply), `add claimed a send it never made:\n${reply}`);
});

test('add embeds the welcome message with {name} already substituted', async () => {
  const store = fakeStore();
  const gm = createManualGroupManager(tgConfig(), log);
  const h = createMemberHandlers(store, gm, tgConfig(), log);
  const reply = await h.handleAdd(['Raju', '9855112233']);
  assert.ok(reply.includes(encodeURIComponent('Welcome Raju ji')), 'welcome text not pre-filled');
});

test('kick marks REMOVED in the sheet and says which groups to clear', async () => {
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'ACTIVE' }]);
  const gm = createManualGroupManager(tgConfig(), log);
  const h = createMemberHandlers(store, gm, tgConfig(), log);

  const reply = await h.handleKick(['9855112233']);

  assert.equal(store.rows[0].status, 'REMOVED', 'sheet was not updated');
  assert.ok(reply.includes('marked REMOVED'));
  assert.ok(reply.includes('SINGH TRAVELS (PAID) (DELHI)'));
  assert.ok(!/Removed .* from \d+\/\d+ groups/.test(reply), `kick claimed a group removal:\n${reply}`);
});

test('kick on an unknown number updates nothing but still gives instructions', async () => {
  const store = fakeStore();
  const gm = createManualGroupManager(tgConfig(), log);
  const h = createMemberHandlers(store, gm, tgConfig(), log);
  const reply = await h.handleKick(['9855112233']);
  assert.equal(store.writes.length, 0);
  assert.ok(reply.includes('not in the sheet'));
  assert.ok(reply.includes('remove 9855112233'));
});

test('links returns every configured link and admits it cannot diff the roster', async () => {
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'ACTIVE' }]);
  const gm = createManualGroupManager(tgConfig(), log);
  const h = createMemberHandlers(store, gm, tgConfig(), log);
  const reply = await h.handleLinks(['9855112233']);
  assert.ok(reply.includes('https://chat.whatsapp.com/AAA111'));
  assert.ok(reply.includes('https://chat.whatsapp.com/BBB222'));
  assert.ok(/can't check which ones/.test(reply), `links overclaimed:\n${reply}`);
});

// ── command gate ──────────────────────────────────────────────────────────────

function tgParser(config = tgConfig(), store = fakeStore()) {
  const gm = createManualGroupManager(config, log);
  return createCommandParser(store, gm, config, log, null, Date.now(), null, null, null, new Set(), null, null);
}

test('live-group commands are refused with a plain explanation, not an error', async () => {
  const parser = tgParser();
  for (const cmd of ['approve', 'approveall', 'reject', 'rejectall', 'groupcheck 9855112233',
                     'notinsheet', 'leftmembers', 'stillin', 'kickghosts', 'diag']) {
    const reply = await parser.parse(cmd);
    assert.match(reply, /needs a live WhatsApp connection/, `"${cmd}" was not refused: ${reply}`);
    assert.ok(!reply.includes('Error processing command'), `"${cmd}" leaked a raw throw`);
  }
});

test('"start removal" and "stop kickall" are refused on a Telegram bot', async () => {
  const parser = tgParser();
  for (const cmd of ['start removal', 'stop removal', 'stop kickall', 'stop kickghosts']) {
    const reply = await parser.parse(cmd);
    assert.match(reply, /drives WhatsApp group operations/, `"${cmd}" was not refused: ${reply}`);
  }
});

test('the refusal names a concrete alternative rather than just saying no', async () => {
  const parser = tgParser();
  assert.match(await parser.parse('approve'), /add \[Name\] \[phone\]/);
  assert.match(await parser.parse('groupcheck 9855112233'), /status \[phone\]/);
});

test('the gate is off for a WhatsApp bot — nothing changes on bot-nitin', async () => {
  const waConfig = tgConfig({ transport: 'whatsapp', profile: 'full' });
  // A live-ish manager, so the command actually runs instead of hitting the manual stub.
  const liveish = { async checkMembership() { return { inGroups: ['g1'], notInGroups: [] }; } };
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'ACTIVE' }]);
  const parser = createCommandParser(
    store, liveish, waConfig, log, null, Date.now(), null, null, null, new Set(), null, null);

  const reply = await parser.parse('groupcheck 9855112233');
  assert.ok(reply.includes('group membership'), `groupcheck did not run on a WhatsApp bot: ${reply}`);
  assert.ok(!/this bot runs on Telegram/.test(reply), `WhatsApp bot got the Telegram refusal: ${reply}`);
});

test('sheet commands still work untouched on a Telegram bot', async () => {
  const store = fakeStore([{ name: 'Raju', phone: '9855112233', status: 'NEW', joinDate: '01-01-2026' }]);
  const parser = tgParser(tgConfig(), store);
  const reply = await parser.parse('find Raju');
  assert.ok(reply.includes('Raju'), `find broke on Telegram: ${reply}`);
});

test('tracker help does not advertise commands a Telegram bot refuses', () => {
  const reportH = createReportHandlers(fakeStore(), tgConfig(), Date.now(), log);
  const help = reportH.handleHelp();
  for (const gone of ['approve / approveall', 'rejectall', 'groupcheck [phone]']) {
    assert.ok(!help.includes(gone), `help still offers "${gone}" on a Telegram bot`);
  }
  assert.ok(help.includes('tap-to-send'), 'help does not explain the manual send flow');
  assert.ok(help.includes('pending'), 'help lost the call funnel');
});

test('tracker help on a WhatsApp bot is unchanged', () => {
  const reportH = createReportHandlers(fakeStore(), tgConfig({ transport: 'whatsapp' }), Date.now(), log);
  const help = reportH.handleHelp();
  assert.ok(help.includes('approve / approveall'));
  assert.ok(help.includes('groupcheck [phone]'));
  assert.ok(!help.includes('tap-to-send'));
});

// ── operator enrolment ────────────────────────────────────────────────────────

// These build a throwaway bot dir rather than reading a real one. The previous version
// asserted against bots/bot-abhi/config.json and broke the moment that bot was given real
// operator ids — a config change in production must never fail the suite, and a test must
// never rewrite a live bot's config to make its point.
function tempBotDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    botName: 'bot-temp',
    paidGroups: ['g1@g.us'],
    ...extra,
  }));
  fs.writeFileSync(path.join(dir, 'service-account.json'), '{}');
  return dir;
}

// loadConfig reads OWNER_NUMBER/SHEET_ID from the environment and throws without them.
async function withEnv(vars, fn) {
  const { loadConfig } = await import('../core/globalConfig.js');
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { OWNER_NUMBER: '9999999999', SHEET_ID: 'sheet', ...vars });
    return await fn(loadConfig);
  } finally {
    process.env = saved;
  }
}

test('an empty allowedTelegramIds means bootstrap, never "allow everyone"', async () => {
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    const c = loadConfig(tempBotDir({ allowedTelegramIds: [] }));
    assert.equal(c.transport, 'telegram');
    assert.equal(c.bootstrapMode, true, 'empty list did not enter bootstrap mode');
    assert.deepEqual(c.allowedTelegramIds, [], 'empty list must not become a wildcard');
  });
});

test('a missing allowedTelegramIds is bootstrap too, not an open door', async () => {
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    const c = loadConfig(tempBotDir());
    assert.equal(c.bootstrapMode, true);
    assert.deepEqual(c.allowedTelegramIds, []);
  });
});

test('configured ids turn bootstrap off and are coerced to numbers', async () => {
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    // Telegram sends from.id as a number; a config written as a string must still match.
    const c = loadConfig(tempBotDir({ allowedTelegramIds: [111, '222'] }));
    assert.equal(c.bootstrapMode, false);
    assert.deepEqual(c.allowedTelegramIds, [111, 222], 'ids were not normalised to numbers');
  });
});

// ── transport resolution (whatsapp / telegram / dual) ─────────────────────────

test('no token means whatsapp, token alone means telegram — tracker bots unchanged', async () => {
  await withEnv({ TELEGRAM_TOKEN: '' }, (loadConfig) => {
    assert.equal(loadConfig(tempBotDir()).transport, 'whatsapp');
  });
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    assert.equal(loadConfig(tempBotDir()).transport, 'telegram');
  });
});

test('an explicit transport in config.json wins over the token inference', async () => {
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    const c = loadConfig(tempBotDir({ transport: 'dual', allowedTelegramIds: [7] }));
    assert.equal(c.transport, 'dual', 'a token must not force "telegram" over a declared "dual"');
    assert.equal(c.usesTelegram, true, 'dual must run a Telegram listener');
    assert.equal(c.bootstrapMode, false);
  });
});

test('telegram-only without a token refuses to start — it could serve nobody', async () => {
  await withEnv({ TELEGRAM_TOKEN: '' }, (loadConfig) => {
    assert.throws(() => loadConfig(tempBotDir({ transport: 'telegram' })), /TELEGRAM_TOKEN/);
  });
});

test('dual without a token degrades to WhatsApp and flags it, rather than bricking a live bot', async () => {
  // The config can legitimately reach git before the Telegram bot is created. Throwing here
  // would take bot-nitin's renewal collection down over a missing backup channel.
  await withEnv({ TELEGRAM_TOKEN: '' }, (loadConfig) => {
    const c = loadConfig(tempBotDir({ transport: 'dual' }));
    assert.equal(c.transport, 'whatsapp', 'a dual bot with no token must still run its primary channel');
    assert.equal(c.usesTelegram, false, 'nothing should try to poll without a token');
    assert.equal(c.telegramMissing, true, 'the degradation must be visible, not silent');
  });
});

test('an unknown transport is rejected rather than silently ignored', async () => {
  await withEnv({ TELEGRAM_TOKEN: '123:FAKE' }, (loadConfig) => {
    assert.throws(() => loadConfig(tempBotDir({ transport: 'signal' })), /Invalid transport/);
  });
});

test('usesTelegram is false on a plain WhatsApp bot', async () => {
  await withEnv({ TELEGRAM_TOKEN: '' }, (loadConfig) => {
    assert.equal(loadConfig(tempBotDir()).usesTelegram, false);
  });
});

test('ping reports the transport instead of a permanently disconnected socket', () => {
  const reportH = createReportHandlers(fakeStore(), tgConfig(), Date.now(), log);
  const reply = reportH.handlePing(null);
  assert.match(reply, /Telegram/);
  assert.ok(!reply.includes('❌ Disconnected'), `ping reads as broken: ${reply}`);
});
