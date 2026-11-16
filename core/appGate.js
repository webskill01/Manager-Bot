import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, randomBetween, daysFromToday, isDelayActive } from './globalConfig.js';
import { liveOnApp } from './appFlow.js';
import { appDate } from './appSync.js';

// Gatekeeper for config.appGroupId (bot-nitin). "On the app" = liveOnApp: paid and running
// right now. A sign-up that never paid is NOT on the app.
//
// 1. Join requests: approved if live on the app, rejected otherwise. A request whose phone
//    WhatsApp hides (LID only, no mapping) or whose app lookup fails is left pending and
//    reported — never decided on a guess.
// 2. Day-3 expiry sweep (9 AM, with app-kick): people in the app group whose paid plan ended
//    2+ days ago are removed from the app group AND every paid group the scan saw them in.
//    Covers bot-abhi's members (abhi is not in the app group) and people on no sheet.
//    bot-nitin's own ACTIVE rows are skipped: its kickall already removes those, delays honoured.
// 3. `appclean`: lists who is in the app group without being on the app; `appclean go`
//    queues them. Nothing is removed from that list without the operator's go.
//
// Removals: one person at a time, 12–20 min apart, daytime only, never during a kickall.
// Each person is looked up live on the app right before removal — paid since → skipped.

// 'live' | 'grace' (paid plan ended today or yesterday) | 'expired' (ended 2+ days ago) | 'none'
export function appVerdict(row, nowIso = new Date().toISOString()) {
  if (liveOnApp(row, nowIso)) return 'live';
  if (!row || !(row.paidCount > 0) || !row.expiresAt) return 'none';
  const d = daysFromToday(appDate(row.expiresAt));
  return d !== null && d >= -1 ? 'grace' : 'expired';
}

// Split the app group's members into the day-3 expired (auto) and the not-on-app (confirm).
// rows: phone → app row. ownActive: phones on this bot's sheet as ACTIVE (its own kickall
// handles them). delayed: phones snoozed on any sheet.
export function sweepLists({ appGroup, admins, exclude, rows, ownActive, delayed, nowIso }) {
  const expired = [], none = [];
  for (const ph of [...appGroup].sort()) {
    if (admins.has(ph) || exclude.has(ph) || delayed.has(ph)) continue;
    const v = appVerdict(rows.get(ph), nowIso);
    if (v === 'expired' && !ownActive.has(ph)) expired.push(ph);
    else if (v === 'none') none.push(ph);
  }
  return { expired, none };
}

// Phone from a pending request's raw attrs: the jid when it is a phone JID, else phone_number.
export function requestPhone(p) {
  for (const cand of [p.jid, p.phone_number, p.phoneNumber]) {
    const s = String(cand || '');
    if (s.endsWith('@s.whatsapp.net')) return normalizePhone(s.split('@')[0].split(':')[0]);
  }
  return null;
}

export function createAppGate({ config, log, getSock, groupScan, appSync, fleet, store, removal, notify, warmingUp = () => false }) {
  const gid = config.appGroupId;
  const file = path.join(config.botDir, 'app-gate.json');
  const s = config.appGate || {};
  const gapMin = s.gapMinMs ?? 12 * 60 * 1000, gapMax = s.gapMaxMs ?? 20 * 60 * 1000;
  const startHour = s.startHour ?? 8, endHour = s.endHour ?? 22;
  const reported = new Set();   // hidden requests already reported this process
  let timer = null, gating = false, again = false;

  const load = () => { try { return { active: false, queue: [], pendingNone: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { active: false, queue: [], pendingNone: [] }; } };
  const save = (st) => fs.writeFileSync(file, JSON.stringify(st, null, 2));
  const rowsByPhone = () => new Map([...appSync.snapshot().values()].map(r => [normalizePhone(String(r.phone)), r]));
  const lookup = async (ph) => (await appSync.lookup(ph)) || null;

  function exclude() {
    const ex = new Set([...(config.allowedNumbers || []), ...(config.auditExclude || [])].map(normalizePhone));
    const self = (getSock()?.user?.id || '').split(':')[0].replace(/\D/g, '');
    if (self) ex.add(normalizePhone(self));
    return ex;
  }

  async function lists() {
    const sheets = fleet ? await fleet.sheets() : [{ members: store.getAll() }];
    const delayed = new Set(sheets.flatMap(x => x.members).filter(isDelayActive).map(m => m.phone));
    const ownActive = new Set(store.getAll().filter(m => m.status === 'ACTIVE').map(m => m.phone));
    return sweepLists({ appGroup: groupScan.appGroup(), admins: groupScan.admins(), exclude: exclude(), rows: rowsByPhone(), ownActive, delayed });
  }

  // ── 1. join requests ────────────────────────────────────────────────────
  async function resolvePhone(sock, p) {
    const ph = requestPhone(p);
    if (ph || !String(p.jid || '').endsWith('@lid')) return ph;
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(p.jid);
      return pn ? normalizePhone(String(pn).split('@')[0].split(':')[0]) : null;
    } catch { return null; }
  }

  async function gateRequests() {
    if (!load().active) return;
    if (gating) { again = true; return; }   // a request mid-run is picked up by one more pass
    gating = true;
    try {
      do {
        again = false;
        const sock = getSock();
        if (!sock?.user || warmingUp()) return;
        const pending = await sock.groupRequestParticipantsList(gid);
        const done = { approve: [], reject: [] }, hidden = [];
        for (const p of pending || []) {
          const ph = await resolvePhone(sock, p);
          if (!ph) { if (!reported.has(p.jid)) { reported.add(p.jid); hidden.push(p.jid); } continue; }
          let row;
          try { row = await lookup(ph); }
          catch (err) { log.warn(`⚠️  App gate: lookup ${ph} failed — left pending (${err.message})`); continue; }
          const action = liveOnApp(row) ? 'approve' : 'reject';
          try {
            await sock.groupRequestParticipantsUpdate(gid, [p.jid], action);
            done[action].push(ph);
            log.info(`🚪 App gate: ${action} ${ph}`);
          } catch (err) { log.warn(`⚠️  App gate: ${action} ${ph} failed — ${err.message}`); }
          await new Promise(r => setTimeout(r, randomBetween(4000, 8000)));
        }
        const lines = [
          done.approve.length && `✅ Approved (live on app): ${done.approve.join(', ')}`,
          done.reject.length && `❌ Rejected (not on app): ${done.reject.join(', ')}`,
          hidden.length && `❔ ${hidden.length} request(s) with a hidden number — left pending, decide by hand`,
        ].filter(Boolean);
        if (lines.length) await notify(`🚪 *App group requests*\n${lines.join('\n')}`);
      } while (again);
    } catch (err) {
      log.warn(`⚠️  App gate: ${err.message}`);
    } finally { gating = false; }
  }

  // Baileys 'group.join-request' event. Debounced: a burst of requests is one pass.
  let debounce = null;
  function onJoinRequest(ev) {
    if (ev?.id !== gid || ev.action !== 'created') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => gateRequests(), 20_000);
    debounce.unref?.();
  }

  // ── 2/3. removals ───────────────────────────────────────────────────────
  function later(ms) { clearTimeout(timer); timer = setTimeout(() => tick().catch(e => log.warn(`⚠️  App gate: ${e.message}`)), ms); timer.unref?.(); }

  async function tick() {
    const st = load();
    if (!st.active || !st.queue.length) return;
    const h = new Date().getHours();
    if (h < startHour || h >= endHour) return later(30 * 60 * 1000);
    if (warmingUp() || !getSock()?.user || removal.kickallActive()) return later(15 * 60 * 1000);
    const ph = st.queue[0];
    let v;
    try { v = appVerdict(await lookup(ph)); }
    catch (err) { log.warn(`⚠️  App gate: lookup ${ph} failed — retry later (${err.message})`); return later(15 * 60 * 1000); }
    if (v === 'live' || v === 'grace') {
      log.info(`🚪 App gate: ${ph} is ${v} on the app now — not removed`);
    } else {
      const groups = [gid, ...groupScan.groupsOf(ph), ...(config.appExtraGroups || [])];
      const { removedCount, interrupted } = await removal.removeFromGroups(ph, groups);
      if (interrupted) return later(15 * 60 * 1000);
      log.info(`🚫 App gate: removed ${ph} from ${removedCount}/${groups.length} group(s) (${v})`);
      await notify(`🚫 App gate removed ${ph} from ${removedCount}/${groups.length} group(s) — ${v === 'expired' ? 'app plan ended 2+ days ago' : 'not on the app'}`);
    }
    const now = load();
    now.queue = now.queue.filter(x => x !== ph);
    save(now);
    if (now.queue.length) later(randomBetween(gapMin, gapMax));
  }

  function enqueue(phones) {
    const st = load();
    const add = phones.filter(p => !st.queue.includes(p));
    st.queue.push(...add);
    save(st);
    if (add.length) later(5000);
    return add.length;
  }

  // 9 AM, right after app-kick.
  async function sweepExpired() {
    if (!load().active) return;
    const { expired } = await lists();
    const n = enqueue(expired);
    if (n) await notify(`🚪 App group: ${n} member(s) whose app plan ended 2+ days ago queued for removal (12–20 min apart).`);
  }

  // ── commands ────────────────────────────────────────────────────────────
  async function clean(arg) {
    const st = load();
    if (arg === 'go') {
      if (!st.pendingNone.length) return 'ℹ️ Nothing to confirm — run `appclean` first.';
      const n = enqueue(st.pendingNone);
      const after = load(); after.pendingNone = []; save(after);
      return `▶️ ${n} queued for removal, one every 12–20 min (8 AM–10 PM). Each is re-checked on the app first.` +
        (st.active ? '' : '\n⚠️ App gate is OFF — `appgate on` to start removing.');
    }
    const { expired, none } = await lists();
    st.pendingNone = none;
    save(st);
    const rows = rowsByPhone();
    const tag = (ph) => (rows.get(ph)?.paidCount ? 'paid before' : rows.has(ph) ? 'signed up, never paid' : 'not on app');
    return [
      `🧹 *App group — not on the app* (scan ${groupScan.at() || 'never'})`,
      none.length ? none.map((ph, i) => `${i + 1}. ${ph} · ${tag(ph)}`).join('\n') : 'Nobody.',
      expired.length ? `\n(${expired.length} more whose plan ended 2+ days ago go automatically at 9 AM.)` : '',
      none.length ? '\nReply `appclean go` to remove these.' : '',
    ].filter(Boolean).join('\n');
  }

  function start() { const st = load(); st.active = true; save(st); later(5000); gateRequests(); return '▶️ App gate on — join requests are checked against the app, day-3 expiries removed at 9 AM.'; }
  function stop() { const st = load(); st.active = false; save(st); clearTimeout(timer); return '⏸️ App gate off — requests and removals paused (queue kept).'; }
  function status() {
    const st = load();
    return `🚪 App gate ${st.active ? 'ON' : 'off'} — ${st.queue.length} queued for removal, ${st.pendingNone.length} awaiting \`appclean go\`.`;
  }
  // Boot / reconnect: catch requests made while offline, resume the queue.
  function resume() { if (!load().active) return; later(10 * 60 * 1000); setTimeout(() => gateRequests(), 60_000).unref?.(); }

  return { onJoinRequest, gateRequests, sweepExpired, clean, start, stop, status, resume };
}
