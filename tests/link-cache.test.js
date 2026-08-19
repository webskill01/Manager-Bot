// Invite links are cached on disk and updated from chat (`refreshlinks` / `setlink`) instead
// of being fetched live on every add — the live path cost 24 WhatsApp round trips per add.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLinkStore } from '../core/linkStore.js';
import { createMemberHandlers } from '../core/handlers/memberHandlers.js';

const log = { info() {}, warn() {}, error() {} };
const GROUPS = ['1@g.us', '2@g.us', '3@g.us'];
const NAMES = ['DELHI ONLY', 'MOHALI ONLY', 'PATIALA ONLY'];
const url = c => `https://chat.whatsapp.com/${c.repeat(22)}`;

function tmpConfig() {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache-'));
  return {
    botDir, paidGroups: GROUPS, groupNames: NAMES,
    joining: { fee: 90 }, renewal: { fullAmount: 90, referralAmount: 45, billingCycleDays: 30 },
    welcomeMessage: 'Welcome {name}',
  };
}

const store = {
  async refresh() {}, getAll() { return []; }, findByPhone() { return null; },
  async add() {}, async update() {},
};

test('setlink writes one link, links lists it with the number setlink takes', async () => {
  const config = tmpConfig();
  const gm = { manual: false, async getInviteLinksForMissing() { throw new Error('must not be called'); } };
  const h = createMemberHandlers(store, gm, config, log);

  assert.match(await h.handleLinks([]), /No invite links cached yet/);

  assert.match(await h.handleSetLink(['2', url('B')]), /MOHALI ONLY/);
  const listed = await h.handleLinks([]);
  assert.match(listed, /2\. MOHALI ONLY/);
  assert.match(listed, /Cached invite links \(1\/3\)/);
  assert.match(listed, /Not cached:[\s\S]*1\. DELHI ONLY[\s\S]*3\. PATIALA ONLY/);
});

test('setlink rejects a bad number and a non-invite url', async () => {
  const config = tmpConfig();
  const h = createMemberHandlers(store, {}, config, log);
  assert.match(await h.handleSetLink(['9', url('A')]), /must be 1-3/);
  assert.match(await h.handleSetLink(['1', 'https://example.com/abc']), /not a WhatsApp invite link/);
  assert.match(await h.handleSetLink(['1']), /Format: setlink/);
});

test('refreshlinks caches every fetched code and keeps the old one for a failure', async () => {
  const config = tmpConfig();
  const gm = {
    async getAllInviteLinks() {
      return {
        fetched: [{ groupId: '1@g.us', index: 1, link: url('A') }, { groupId: '3@g.us', index: 3, link: url('C') }],
        failed: [{ groupId: '2@g.us', index: 2, error: 'timed out' }],
      };
    },
  };
  const h = createMemberHandlers(store, gm, config, log);

  await h.handleSetLink(['2', url('Z')]);           // pre-existing link for the group that fails
  const out = await h.handleRefreshLinks();
  assert.match(out, /Cached 2\/3 invite links/);
  assert.match(out, /2\. MOHALI ONLY — timed out/);

  const all = createLinkStore(config, log).all();
  assert.equal(all.length, 3, 'the failed group keeps its previous link');
  assert.equal(all.find(l => l.groupId === '2@g.us').link, url('Z'));
});

test('refreshlinks on a socket-less bot says so and points at setlink', async () => {
  const config = tmpConfig();
  const gm = { manual: true, async getAllInviteLinks() { throw new Error('No WhatsApp connection'); } };
  const h = createMemberHandlers(store, gm, config, log);
  const out = await h.handleRefreshLinks();
  assert.match(out, /Cannot refresh: No WhatsApp connection/);
  assert.match(out, /setlink/);
});

test('sendlinks uses the cache and never touches the live fetch', async () => {
  const config = tmpConfig();
  let liveCalls = 0;
  const gm = {
    async getInviteLinksForMissing() { liveCalls++; return []; },
  };
  const h = createMemberHandlers(store, gm, config, log);
  for (const [i, c] of ['A', 'B', 'C'].entries()) await h.handleSetLink([String(i + 1), url(c)]);

  const out = await h.handleSendLinks(['9876543210']);
  assert.equal(liveCalls, 0, 'a cached link set means zero WhatsApp round trips');
  // The message rides inside the wa.me tap link, so names arrive percent-encoded.
  assert.match(out, /DELHI%20ONLY/);
  assert.match(out, /PATIALA%20ONLY/);
  assert.doesNotMatch(out, /No invite links/);
});

test('an empty cache still falls back to the live fetch', async () => {
  const config = tmpConfig();
  let liveCalls = 0;
  const gm = {
    async getInviteLinksForMissing() {
      liveCalls++;
      return [{ groupId: '1@g.us', groupName: 'DELHI ONLY', link: url('A') }];
    },
  };
  const h = createMemberHandlers(store, gm, config, log);
  const out = await h.handleSendLinks(['9876543210']);
  assert.equal(liveCalls, 1);
  assert.match(out, /DELHI%20ONLY/);
});
