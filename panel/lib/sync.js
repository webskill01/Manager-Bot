import { google } from 'googleapis';
import { createSheetClient } from '../../core/sheetClient.js';
import { createAppClient } from '../../core/appClient.js';
import { normalizePhone, parseDate } from '../../core/globalConfig.js';
import { buildPeople } from './people.js';

// Keeps the latest picture of every member in memory. Sheets and the app are polled every
// syncMs; a failed source keeps its last good data so one bad read never empties the panel.
// Quota: 4-5 sheet reads per 2 min against Google's 60/min.

const APP_FULL_EVERY_MS = 60 * 60e3;
const APP_OVERLAP_MS = 2 * 60e3;
const ALL_NUMBERS_EVERY_MS = 30 * 60e3;
const PAYMENT_DEDUPE_MS = 3 * 86400e3;

// Pure. Who paid between two snapshots: their app plan was extended (source app = moved to
// the app), or else their billing date moved forward on a bot (source sheet = renewed in the
// groups the old way). Both moving together (the bot's own app sync bumps the sheet) is one
// app payment. The first snapshot (prev empty) records nothing.
export function detectPayments(prev, next, botCfg) {
  if (!prev.size) return [];
  const at = new Date().toISOString();
  const out = [];
  for (const p of next.values()) {
    const before = prev.get(p.phone);
    if (!before) continue;
    let hit = null;
    // Moved to the app (first time on it), or paid again on it.
    if (p.onApp && (!before.onApp || (p.app.expiresAt || '') > (before.app?.expiresAt || ''))) {
      const m = (before.active[0] || before.members[0]);
      hit = { phone: p.phone, bot: m?.bot || 'app', amount: Number(p.app.lastAmount) || 0, billingFrom: m?.member.billingDate || '', source: 'app', at };
    }
    for (const { bot, member } of hit ? [] : p.members) {
      const old = before.members.find(x => x.bot === bot)?.member;
      const a = parseDate(old?.billingDate), b = parseDate(member.billingDate);
      if (a && b && b > a) {
        hit = { phone: p.phone, bot, amount: Number(member.paidLast) || botCfg[bot]?.renewal?.fullAmount || 0, billingFrom: old.billingDate, source: 'sheet', at };
        break;
      }
    }
    if (hit) out.push(hit);
  }
  return out;
}

export function createSync({ env, botCfg, db, log = console }) {
  const bots = Object.keys(env.sheets);
  const clients = {};
  const data = { sheets: {}, app: new Map(), allNumbers: [] };
  const status = { lastSync: null, errors: {} };
  let people = new Map();
  let lastAppFull = 0, lastAppPoll = 0, lastAllNumbers = 0;
  let rawSheets = null;
  const app = createAppClient({ appSyncUrl: env.appSyncUrl, appSyncToken: env.appSyncToken });

  async function init() {
    for (const bot of bots) clients[bot] = await createSheetClient(env.serviceAccount, env.sheets[bot], log);
    if (env.allNumbersSheet) {
      const auth = new google.auth.GoogleAuth({ keyFile: env.serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      rawSheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    }
  }

  const note = (src, err) => {
    status.errors[src] = err ? `${new Date().toISOString()} ${err.message.split('\n')[0]}` : undefined;
    if (err) log.warn(`panel sync ${src} failed: ${err.message.split('\n')[0]}`);
  };

  async function readBot(bot) {
    try { data.sheets[bot] = await clients[bot].getAll(); note(bot); } catch (e) { note(bot, e); }
  }

  async function readApp(phones) {
    if (!app) return;
    try {
      const now = Date.now();
      let res;
      if (phones) res = await app.memberships({ phones });
      else if (now - lastAppFull > APP_FULL_EVERY_MS) { res = await app.memberships(); lastAppFull = now; data.app.clear(); }
      else res = await app.memberships({ since: new Date(lastAppPoll - APP_OVERLAP_MS) });
      if (!phones) lastAppPoll = now;
      for (const row of res.members || []) data.app.set(normalizePhone(row.phone), row);
      note('app');
    } catch (e) { note('app', e); }
  }

  async function readAllNumbers() {
    if (!rawSheets || Date.now() - lastAllNumbers < ALL_NUMBERS_EVERY_MS) return;
    try {
      const res = await rawSheets.spreadsheets.values.get({ spreadsheetId: env.allNumbersSheet, range: 'ALL_NUMBERS!A2:B', valueRenderOption: 'UNFORMATTED_VALUE' });
      data.allNumbers = res.data.values || [];
      lastAllNumbers = Date.now();
      note('allNumbers');
    } catch (e) { note('allNumbers', e); }
  }

  function rebuild() {
    const next = buildPeople({ sheets: data.sheets, app: [...data.app.values()], allNumbers: data.allNumbers });
    const since = new Date(Date.now() - PAYMENT_DEDUPE_MS);
    for (const pay of detectPayments(people, next, botCfg)) {
      if (db.auditByAction('payment_seen', since, new Date(Date.now() + 1000)).some(a => a.target === pay.phone)) continue;
      db.audit(null, 'payment_seen', pay.phone, pay);
      db.closeFollowups(pay.phone);
    }
    people = next;
    status.lastSync = new Date().toISOString();
  }

  let running = null;
  function refresh() {
    running ??= (async () => {
      await Promise.all([...bots.map(readBot), readApp(), readAllNumbers()]);
      rebuild();
    })().finally(() => { running = null; });
    return running;
  }

  // One person, fresh, right before a caller dials them: their bots' sheets + their app row.
  async function recheck(phone) {
    const p = people.get(phone);
    const theirBots = p ? [...new Set(p.members.map(m => m.bot))] : [];
    await Promise.all([...theirBots.map(readBot), readApp([phone])]);
    rebuild();
    return people.get(phone) || null;
  }

  let timer = null;
  return {
    async start() {
      await init();
      await refresh();
      timer = setInterval(() => refresh().catch(e => log.error(`panel sync: ${e.message}`)), env.syncMs);
    },
    stop: () => clearInterval(timer),
    refresh,
    recheck,
    people: () => people,
    client: (bot) => clients[bot],
    status: () => ({ ...status, bots, members: people.size }),
  };
}
