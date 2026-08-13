import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeParam, toWaId, buildTemplatePayload,
  isConfigured, usesCloudApi, createCloudApiSender,
} from '../core/cloudApiSender.js';
import { createOverdueEngine } from '../core/overdueEngine.js';
import { formatDate } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

const cloudCfg = (extra = {}) => ({
  reminderChannel: 'cloudapi',
  cloudApi: {
    phoneNumberId: '123456',
    token: 'TOKEN',
    templateName: 'renewal_reminder',
    languageCode: 'en',
    ...extra,
  },
});

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    impl: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
      };
    },
  };
}

const OK = { status: 200, body: { messages: [{ id: 'wamid.TEST' }] } };

// ── pure helpers ─────────────────────────────────────────────────────────────

test('sanitizeParam strips what Meta rejects in template variables', () => {
  assert.equal(sanitizeParam('Ravi\nKumar'), 'Ravi Kumar', 'newlines are rejected by Meta');
  assert.equal(sanitizeParam('A\t\tB'), 'A B');
  assert.equal(sanitizeParam('A          B'), 'A   B', '4+ spaces collapse to 3');
  assert.equal(sanitizeParam('  padded  '), 'padded');
  assert.equal(sanitizeParam(null), '');
  assert.equal(sanitizeParam(42), '42');
});

test('toWaId turns a 10-digit sheet phone into an international wa_id', () => {
  assert.equal(toWaId('9876543210'), '919876543210');
  assert.equal(toWaId('919876543210'), '919876543210', 'already prefixed, left alone');
  assert.equal(toWaId('+91 98765 43210'), '919876543210');
  assert.equal(toWaId('9876543210', '1'), '19876543210');
  assert.equal(toWaId(''), '');
});

test('buildTemplatePayload matches the Cloud API template schema', () => {
  const p = buildTemplatePayload({
    phone: '9876543210',
    templateName: 'renewal_reminder',
    bodyParams: ['Ravi', '6', '27 July'],
  });
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '919876543210');
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'renewal_reminder');
  assert.deepEqual(p.template.language, { code: 'en' });
  assert.deepEqual(p.template.components, [
    { type: 'body', parameters: [
      { type: 'text', text: 'Ravi' },
      { type: 'text', text: '6' },
      { type: 'text', text: '27 July' },
    ] },
  ]);
});

test('buildTemplatePayload adds a header image only when one is given', () => {
  const withImg = buildTemplatePayload({
    phone: '9876543210', templateName: 't', bodyParams: ['A'],
    headerImageUrl: 'https://example.com/qr.jpg',
  });
  assert.equal(withImg.template.components[0].type, 'header');
  assert.equal(withImg.template.components[0].parameters[0].image.link, 'https://example.com/qr.jpg');

  const bare = buildTemplatePayload({ phone: '9876543210', templateName: 't' });
  assert.equal(bare.template.components, undefined, 'no empty components array');
});

test('buildTemplatePayload sanitises body params on the way in', () => {
  const p = buildTemplatePayload({ phone: '9876543210', templateName: 't', bodyParams: ['Ravi\nKumar'] });
  assert.equal(p.template.components[0].parameters[0].text, 'Ravi Kumar');
});

// ── configuration gating ─────────────────────────────────────────────────────

test('isConfigured requires all three credentials', () => {
  assert.equal(isConfigured(cloudCfg()), true);
  assert.equal(isConfigured({ cloudApi: { phoneNumberId: '1', token: 't' } }), false, 'no template');
  assert.equal(isConfigured({ cloudApi: { phoneNumberId: '1', templateName: 'x' } }), false, 'no token');
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured(null), false);
});

test('usesCloudApi is off unless the channel flag AND the credentials are both present', () => {
  assert.equal(usesCloudApi(cloudCfg()), true);
  assert.equal(usesCloudApi({ ...cloudCfg(), reminderChannel: 'group' }), false, 'configured but not selected');
  assert.equal(usesCloudApi({ reminderChannel: 'cloudapi' }), false, 'selected but not configured');
  assert.equal(usesCloudApi({}), false, 'default is off — nothing changes until flipped');
});

// ── sending ──────────────────────────────────────────────────────────────────

test('sendTemplate posts to the right endpoint with a bearer token', async () => {
  const f = fakeFetch([OK]);
  const sender = createCloudApiSender(cloudCfg(), log, { fetchImpl: f.impl });
  const res = await sender.sendTemplate({ phone: '9876543210', bodyParams: ['Ravi', '6', '27 July'] });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'wamid.TEST');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://graph.facebook.com/v21.0/123456/messages');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer TOKEN');
  assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(f.calls[0].body.to, '919876543210');
});

test('sendTemplate honours a pinned API version', async () => {
  const f = fakeFetch([OK]);
  const sender = createCloudApiSender(cloudCfg({ apiVersion: 'v23.0' }), log, { fetchImpl: f.impl });
  await sender.sendTemplate({ phone: '9876543210' });
  assert.match(f.calls[0].url, /\/v23\.0\//);
});

test('sendTemplate refuses to send when unconfigured', async () => {
  const f = fakeFetch([OK]);
  const sender = createCloudApiSender({ cloudApi: { token: 't' } }, log, { fetchImpl: f.impl });
  const res = await sender.sendTemplate({ phone: '9876543210' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not configured/);
  assert.equal(f.calls.length, 0, 'no request is made');
});

test('a 4xx from Meta is reported as non-retryable, a 429 and 5xx as retryable', async () => {
  const bad = createCloudApiSender(cloudCfg(), log, {
    fetchImpl: fakeFetch([{ status: 400, body: { error: { message: 'Template not found', code: 132001 } } }]).impl,
  });
  const r1 = await bad.sendTemplate({ phone: '9876543210' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'Template not found');
  assert.equal(r1.code, 132001);
  assert.equal(r1.retryable, false, 'retrying a bad template just fails again');

  for (const status of [429, 500, 503]) {
    const s = createCloudApiSender(cloudCfg(), log, {
      fetchImpl: fakeFetch([{ status, body: { error: { message: 'busy' } } }]).impl,
    });
    const r = await s.sendTemplate({ phone: '9876543210' });
    assert.equal(r.retryable, true, `${status} is retryable`);
  }
});

test('a network failure is caught and reported, never thrown at the caller', async () => {
  const sender = createCloudApiSender(cloudCfg(), log, {
    fetchImpl: fakeFetch([new Error('ECONNREFUSED')]).impl,
  });
  const res = await sender.sendTemplate({ phone: '9876543210' });
  assert.equal(res.ok, false);
  assert.equal(res.retryable, true);
  assert.match(res.error, /ECONNREFUSED/);
});

// ── integration with the final reminder ──────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

function makeStore(initial) {
  const members = initial.map(m => ({ ...m }));
  return {
    async refresh() {},
    getActive() { return members.filter(m => m.status === 'ACTIVE'); },
    getAll() { return members.map(m => ({ ...m })); },
  };
}

const overdueBase = botDir => ({
  botDir,
  overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  rateLimits: { memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0 },
  reminder: { mode: 'group', groupId: 'g1@g.us' },
  messages: {
    overdue: 'overdue {name} {days}',
    finalReminder: 'final {name}',
    groupOverdue: 'GROUP OVERDUE',
    groupFinal: 'GROUP FINAL',
    overdueConsolidated: 'LIST {count}\n{list}',
  },
});

test('with cloudapi active the final reminder goes via Meta, and NOT to the group', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const waSent = [];
  const sock = {
    user: { id: 'bot' },
    async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, msg) { waSent.push({ jid, msg }); },
  };

  const originalFetch = globalThis.fetch;
  const f = fakeFetch([OK]);
  globalThis.fetch = f.impl;
  try {
    const config = { ...overdueBase(botDir), ...cloudCfg() };
    const engine = createOverdueEngine(config, log);
    await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);

    assert.equal(f.calls.length, 1, 'one Cloud API send');
    assert.equal(f.calls[0].body.to, '919000000001');
    assert.equal(f.calls[0].body.template.name, 'renewal_reminder');
    assert.equal(waSent.filter(s => s.jid === 'g1@g.us').length, 0, 'no group final message');
    assert.equal(waSent.filter(s => s.jid === '919000000001@s.whatsapp.net').length, 0, 'no Baileys DM');
  } finally {
    globalThis.fetch = originalFetch;
  }

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('a Cloud API failure is recorded, NOT retried over WhatsApp', async () => {
  // This used to fall back to the group message. It must not: the failures that actually
  // happen are an expired token or an unfunded balance, which fail for EVERY member at once
  // — so the "safety net" would fire a full batch of proactive payment-demand traffic from
  // the Baileys number, the exact thing the Cloud API exists to stop, at the worst moment.
  // The failure is logged and recorded instead; the operator sends those few by hand.
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const waSent = [];
  const sock = {
    user: { id: 'bot' },
    async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, msg) { waSent.push({ jid, msg }); },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch([{ status: 401, body: { error: { message: 'token expired', code: 190 } } }]).impl;
  try {
    const config = { ...overdueBase(botDir), ...cloudCfg() };
    const engine = createOverdueEngine(config, log);
    await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);

    assert.equal(waSent.filter(s => s.jid === 'g1@g.us').length, 0, 'fell back to a group send');
    assert.equal(waSent.filter(s => s.jid.endsWith('@s.whatsapp.net') && s.jid.startsWith('919000000001')).length, 0,
      'fell back to a Baileys DM — this is the ban traffic the channel exists to avoid');

    const state = JSON.parse(fs.readFileSync(path.join(botDir, 'overdue-state.json'), 'utf8'));
    assert.equal(state.failures?.length, 1, 'the failure was not recorded anywhere');
    assert.match(state.failures[0].error, /token expired/);
    assert.equal(state.failures[0].code, 190, "Meta's error code is what distinguishes a dead token from a bad number");
    assert.ok(!state.sentPhones.includes('9000000001'), 'a failed send must not be marked as sent');
  } finally {
    globalThis.fetch = originalFetch;
  }

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('with cloudapi configured but not selected, nothing is sent through Meta', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const waSent = [];
  const sock = {
    user: { id: 'bot' },
    async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, msg) { waSent.push({ jid, msg }); },
  };

  const originalFetch = globalThis.fetch;
  const f = fakeFetch([OK]);
  globalThis.fetch = f.impl;
  try {
    const config = { ...overdueBase(botDir), ...cloudCfg(), reminderChannel: 'group' };
    const engine = createOverdueEngine(config, log);
    await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);

    assert.equal(f.calls.length, 0, 'flag off — Meta is never called');
    assert.equal(waSent.filter(s => s.jid === 'g1@g.us').length, 1, 'group mode still works');
  } finally {
    globalThis.fetch = originalFetch;
  }

  fs.rmSync(botDir, { recursive: true, force: true });
});
