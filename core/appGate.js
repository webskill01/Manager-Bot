import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, randomBetween, daysFromToday, isDelayActive } from './globalConfig.js';
import { liveOnApp } from './appFlow.js';
import { appDate } from './appSync.js';

// Gatekeeper for config.appGroupId (bot-nitin). "On the app" = liveOnApp: an active
// membership running right now, paid on the app or given by hand. A bare sign-up is NOT.
//
// People are judged by their APP number: appPhoneOf maps a WhatsApp number to the app number
// from their join template (or an operator `applink`), else the WhatsApp number itself.
//
// 1. Join requests (requestAction): live on the app → approved, unless that app account is
//    already used by another app-group member (shared link) → held + reported. Not live and
//    known (template/link, or the app has a plan row) → rejected. Unknown number → held, so a
//    payer who joined from another number can still send the template; rejected after
//    holdDays. A hidden (LID) number or a failed lookup is left pending — never a guess.
// 2. Day-3 expiry sweep (9 AM, with app-kick): people in the app group whose paid plan ended
//    2+ days ago are removed from the app group AND every paid group the scan saw them in.
//    Covers bot-abhi's members (abhi is not in the app group) and people on no sheet.
//    bot-nitin's own ACTIVE rows are skipped: its kickall already removes those, delays honoured.
// 3. `appclean`: lists who is in the app group without being on the app; `appclean go`
//    queues them. Nothing is removed from that list without the operator's go.
//
// Removals: one person at a time, 12–20 min apart, daytime only, never during a kickall.
// Each person is looked up live on the app right before removal — paid since → skipped.

// 'live' | 'grace' (membership ended today or yesterday) | 'expired' (ended 2+ days ago) | 'none'
export function appVerdict(row, nowIso = new Date().toISOString()) {
  if (liveOnApp(row, nowIso)) return 'live';
  if (!row?.expiresAt || row.expiresAt > nowIso) return 'none';
  const d = daysFromToday(appDate(row.expiresAt));
  return d !== null && d >= -1 ? 'grace' : 'expired';
}

// Split the app group's members into the day-3 expired (auto) and the not-on-app (confirm).
// rows: phone → app row. ownActive: phones on this bot's sheet as ACTIVE (its own kickall
// handles them). delayed: phones snoozed on any sheet. appPhoneOf: WhatsApp number → the
// number they signed up on the app with (join template), when they differ.
export function sweepLists({ appGroup, admins, exclude, rows, ownActive, delayed, nowIso, appPhoneOf = (p) => p }) {
  const expired = [], none = [];
  for (const ph of [...appGroup].sort()) {
    const ap = appPhoneOf(ph);
    if (admins.has(ph) || exclude.has(ph) || delayed.has(ph) || delayed.has(ap)) continue;
    const v = appVerdict(rows.get(ap), nowIso);
    // ownActive skip only when the group number IS the sheet number: kickall removes the sheet
    // number, so a member linked to another app number would never leave.
    if (v === 'expired' && !ownActive.has(ph)) expired.push(ph);
    else if (v === 'none') none.push(ph);
  }
  return { expired, none };
}

// One join request → 'approve' | 'reject' | 'hold' | 'shared' (live, but the app account is
// already used by sharedWith in the group). known: number sent the template / was linked /
// has an app plan row. heldSince: ms when this request was first held.
export function requestAction({ row, known, sharedWith = null, heldSince = 0, nowMs = Date.now(), holdDays = 3 }) {
  if (liveOnApp(row)) return sharedWith ? 'shared' : 'approve';
  if (known || row) return 'reject';
  return heldSince && nowMs - heldSince >= holdDays * 864e5 ? 'reject' : 'hold';
}

// Phone from a pending request's raw attrs: the jid when it is a phone JID, else phone_number.
export function requestPhone(p) {
  for (const cand of [p.jid, p.phone_number, p.phoneNumber]) {
    const s = String(cand || '');
    if (s.endsWith('@s.whatsapp.net')) return normalizePhone(s.split('@')[0].split(':')[0]);
  }
  return null;
}

export function createAppGate({ config, log, getSock, groupScan, appSync, fleet, store, removal, notify, warmingUp = () => false, hasDm = () => true, onApproved = async () => null, appPhoneOf = (p) => p, knows = () => false }) {
  const gid = config.appGroupId;
  const file = path.join(config.botDir, 'app-gate.json');
  const s = config.appGate || {};
  const gapMin = s.gapMinMs ?? 12 * 60 * 1000, gapMax = s.gapMaxMs ?? 20 * 60 * 1000;
  const startHour = s.startHour ?? 8, endHour = s.endHour ?? 22;
  const reported = new Set();   // hidden / waiting requests already reported this process
  let timer = null, gating = false, again = false;

  const holdDays = s.holdDays ?? 3;
  const load = () => { try { return { active: false, queue: [], pendingNone: [], held: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { active: false, queue: [], pendingNone: [], held: {} }; } };
  // Another app-group member already using this app number (not ph itself).
  const sharedWith = (ph, ap) => [...(groupScan?.appGroup() || [])].find(o => o !== ph && appPhoneOf(o) === ap) || null;
  const save = (st) => fs.writeFileSync(file, JSON.stringify(st, null, 2));
  const rowsByPhone = () => new Map([...appSync.snapshot().values()].map(r => [normalizePhone(String(r.phone)), r]));
  const lookup = async (ph) => (await appSync.lookup(appPhoneOf(ph))) || null;

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
    return sweepLists({ appGroup: groupScan.appGroup(), admins: groupScan.admins(), exclude: exclude(), rows: rowsByPhone(), ownActive, delayed, appPhoneOf });
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
        // Not gated on warm-up: answering join requests is routine admin work on a fresh
        // link (operator's call, 16-11-2026). Removals below still wait the warm-up out.
        if (!sock?.user) return;
        const pending = await sock.groupRequestParticipantsList(gid);
        const done = { approve: [], reject: [] }, hidden = [], waiting = [], heldNow = [], shared = [];
        const st = load(), held = {}, nowMs = Date.now();
        for (const p of pending || []) {
          const ph = await resolvePhone(sock, p);
          if (!ph) { if (!reported.has(p.jid)) { reported.add(p.jid); hidden.push(p.jid); } continue; }
          let row;
          try { row = await lookup(ph); }
          catch (err) { log.warn(`⚠️  App gate: lookup ${ph} failed — left pending (${err.message})`); if (st.held[ph]) held[ph] = st.held[ph]; continue; }
          const ap = appPhoneOf(ph);
          const action = requestAction({ row, known: ap !== ph || knows(ph), sharedWith: liveOnApp(row) ? sharedWith(ph, ap) : null,
            heldSince: st.held[ph] || 0, nowMs, holdDays });
          if (action === 'hold') { held[ph] = st.held[ph] || nowMs; if (!reported.has(ph)) { reported.add(ph); heldNow.push(ph); } continue; }
          if (action === 'shared') { if (!reported.has(ph)) { reported.add(ph); shared.push(`${ph} (app ${ap} already used by ${sharedWith(ph, ap)})`); } continue; }
          // Active but hasn't DMed the template yet → wait; their template triggers another pass.
          if (action === 'approve' && !hasDm(ph)) { if (!reported.has(ph)) { reported.add(ph); waiting.push(ph); } continue; }
          try {
            await sock.groupRequestParticipantsUpdate(gid, [p.jid], action);
            done[action].push(ph);
            log.info(`🚪 App gate: ${action} ${ph}`);
          } catch (err) { log.warn(`⚠️  App gate: ${action} ${ph} failed — ${err.message}`); }
          await new Promise(r => setTimeout(r, randomBetween(4000, 8000)));
        }
        // Held list = requests still pending and still held (decided/withdrawn ones drop out).
        if (JSON.stringify(held) !== JSON.stringify(st.held)) save({ ...load(), held });
        // Approved and already on a sheet → contact + sheet row now (appIntake.auto).
        const intaken = [];
        for (const ph of done.approve) {
          try { const t = await onApproved(ph); if (t) intaken.push(t); }
          catch (err) { log.warn(`⚠️  App gate: intake ${ph} failed — ${err.message}`); }
        }
        const lines = [
          done.approve.length && `✅ Approved (active on app): ${done.approve.join(', ')}`,
          intaken.length && intaken.join('\n'),
          done.reject.length && `❌ Rejected (no active membership): ${done.reject.join(', ')}`,
          waiting.length && `⏳ Active on app, waiting for their DM (template) before approving: ${waiting.join(', ')}`,
          heldNow.length && `🕓 Number not on the app — held ${holdDays} days for their template (or \`applink <wa> <app>\`), then rejected: ${heldNow.join(', ')}`,
          shared.length && `⚠️ Held — one app account, one member. Not approved: ${shared.join('; ')}`,
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
    const tag = (ph) => { const r = rows.get(appPhoneOf(ph)); return r?.expiresAt ? 'membership ended' : r ? 'signed up, no membership' : 'not on app'; };
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
  // Plus a pass every 30 min: the join-request event can be missed (reconnects, old requests).
  let sweep = null;
  function resume() {
    if (!load().active) return;
    later(10 * 60 * 1000);
    setTimeout(() => gateRequests(), 60_000).unref?.();
    if (!sweep) { sweep = setInterval(() => gateRequests(), 30 * 60 * 1000); sweep.unref?.(); }
  }

  return { onJoinRequest, gateRequests, sweepExpired, clean, start, stop, status, resume };
}
