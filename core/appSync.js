import fs from 'fs';
import path from 'path';
import { formatDate, formatDateTime, parseDate, todayStr, daysFromToday, friendlyDate } from './globalConfig.js';
import { APP_STATUS_PENDING } from './appFlow.js';

// EaseCab app → sheet. The app is the source of truth for who paid; the sheet keeps
// everything else (per-bot data, referrals, call results).
//
// No event log is needed: APP_PAID_UNTIL (column S) is the last app expiry this sheet has
// seen for the phone. An app expiry LATER than it is a new payment, so a missed poll, a
// restart or a duplicate row in the API answer can never double-count — the next poll
// compares the same two dates and finds nothing new.

const FULL_EVERY_MS = 60 * 60 * 1000;   // a full snapshot hourly backs up the incremental polls
const OVERLAP_MS = 2 * 60 * 1000;       // incremental `since` overlaps the last poll
const PENDING_GIVE_UP_DAYS = 7;

// App expiry instant → the sheet's DD-MM-YYYY, in the bot's local time zone like every
// other date in the sheet.
export function appDate(iso) {
  return iso ? formatDate(new Date(iso)) : '';
}

// Pure: which sheet rows a set of app memberships changes.
//   activate — PENDING_APP or REMOVED rows that now have a live app subscription: they need
//              group links, so the operator is told and handed them.
//   renew    — ACTIVE rows whose app expiry moved past the APP_PAID_UNTIL on file.
// Rows on other statuses (SKIPPED, tracker NEW/CALLED) are the operator's decision; the
// sheet value is still updated so `platform` shows the truth, but nobody is pinged.
export function planSync(members, appRows, nowIso = new Date().toISOString()) {
  const byPhone = new Map(appRows.map(r => [r.phone, r]));
  const renew = [], activate = [], quiet = [];
  for (const m of members) {
    const r = byPhone.get(m.phone);
    if (!r || r.status !== 'active' || !r.expiresAt || r.expiresAt <= nowIso) continue;
    const until = appDate(r.expiresAt);
    const known = parseDate(m.appPaidUntil);
    if (known && parseDate(until) <= known) continue;
    const entry = { member: m, until, amount: r.lastAmount ?? 0, first: !m.appPaidUntil };
    if (m.status === APP_STATUS_PENDING || m.status === 'REMOVED') activate.push(entry);
    else if (m.status === 'ACTIVE') renew.push(entry);
    else quiet.push(entry);
  }
  return { renew, activate, quiet };
}

// The row update one entry writes. Same fields `renewed` writes, plus column S.
export function updatesFor({ member, until, amount }, kind) {
  const base = { appPaidUntil: until, delayUntil: '' };
  if (kind === 'quiet') return base;
  return {
    ...base,
    status: 'ACTIVE',
    billingDate: until,
    renewals: (member.renewals || 0) + (kind === 'renew' ? 1 : 0),
    paidLast: amount,
    lastRenewed: formatDateTime(new Date()),
    ...(kind === 'activate' && member.status === APP_STATUS_PENDING ? { joinDate: todayStr() } : {}),
  };
}

// Pending rows that have waited too long. Returns the ones to mention once.
export function stalePending(members, notified) {
  return members.filter(m => m.status === APP_STATUS_PENDING
    && !notified[m.phone]
    && (daysFromToday(m.joinDate) ?? 0) <= -PENDING_GIVE_UP_DAYS);
}

export function createAppSync({ config, log, store, client, notify, linksFor, onPayments = null }) {
  const stateFile = path.join(config.botDir || '.', 'app-sync-state.json');
  const snapshot = new Map();   // phone → latest app membership row, for `platform` & co.
  let lastPollAt = null;
  let lastFullAt = 0;
  let timer = null;
  let running = false;

  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { pendingNotified: {} }; }
  }
  function saveState(s) {
    try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
    catch (err) { log.warn(`⚠️  app-sync state write failed: ${err.message}`); }
  }

  async function pull() {
    const full = Date.now() - lastFullAt >= FULL_EVERY_MS || !lastPollAt;
    const since = full ? undefined : new Date(lastPollAt.getTime() - OVERLAP_MS);
    const started = new Date();
    const res = await client.memberships({ since });
    if (res.truncated) log.warn('⚠️  App sync: API page was truncated — some members not seen this poll');
    for (const r of res.members) snapshot.set(r.phone, r);
    lastPollAt = started;
    if (full) lastFullAt = Date.now();
    return res.members;
  }

  async function apply(plan) {
    const writes = [
      ...plan.renew.map(e => ({ phone: e.member.phone, updates: updatesFor(e, 'renew') })),
      ...plan.activate.map(e => ({ phone: e.member.phone, updates: updatesFor(e, 'activate') })),
      ...plan.quiet.map(e => ({ phone: e.member.phone, updates: updatesFor(e, 'quiet') })),
    ];
    if (writes.length) await store.updateEach(writes);
  }

  async function ping(plan, firstRun) {
    const n = plan.renew.length + plan.activate.length;
    if (firstRun) {
      // First sync on a sheet with an empty column S: everyone who already pays on the app
      // shows up at once. One summary, not a ping per person.
      if (n + plan.quiet.length) await notify(`📱 App sync started — ${n + plan.quiet.length} member(s) matched to app subscriptions and marked.`);
      for (const e of plan.activate) await notify(await activationText(e));
      return;
    }
    for (const e of plan.renew) {
      await notify(`✅ App payment — ${e.member.name} (${e.member.phone}) renewed till ${friendlyDate(e.until)}${e.amount ? ` · ₹${e.amount}` : ''}`);
    }
    for (const e of plan.activate) await notify(await activationText(e));
  }

  async function activationText({ member, until }) {
    const was = member.status === 'REMOVED' ? 'was removed, paid again' : 'new member';
    const head = `🎉 Paid on the app — ${member.name} (${member.phone}), ${was}. Active till ${friendlyDate(until)}.`;
    try { return `${head}\n\n${await linksFor(member.phone)}`; }
    catch (err) { return `${head}\nSend the group links: sendlinks ${member.phone}`; }
  }

  async function checkPending(state) {
    for (const m of stalePending(store.getAll(), state.pendingNotified)) {
      await notify(`⌛ ${m.name} (${m.phone}) was added ${PENDING_GIVE_UP_DAYS}+ days ago and still hasn't paid on the app. No more checks — remove the row or re-add when they pay.`);
      state.pendingNotified[m.phone] = todayStr();
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const state = loadState();
      const firstRun = !state.started;
      const rows = await pull();
      if (rows.length) {
        await store.refresh();
        const plan = planSync(store.getAll(), rows);
        if (plan.renew.length + plan.activate.length + plan.quiet.length) {
          await apply(plan);
          await ping(plan, firstRun);
          if (!firstRun && onPayments) await onPayments([...plan.renew, ...plan.activate]);
        }
      }
      await checkPending(state);
      state.started = state.started || new Date().toISOString();
      saveState(state);
    } catch (err) {
      log.warn(`⚠️  App sync failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  // Live lookup for one phone (sendlinks, platform). Updates the snapshot as a side effect.
  async function lookup(phone) {
    const res = await client.memberships({ phones: [phone] });
    const row = res.members.find(r => r.phone === phone) || null;
    if (row) snapshot.set(phone, row);
    return row;
  }

  function start() {
    const every = Math.max(30, Number(config.app?.pollSeconds) || 60) * 1000;
    tick();
    timer = setInterval(tick, every);
    timer.unref?.();
    log.info(`📱 App sync on — polling every ${every / 1000}s`);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick, lookup, snapshot: () => snapshot };
}
