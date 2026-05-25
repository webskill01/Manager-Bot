import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone } from './globalConfig.js';

const MIN_GAP_MS = 15 * 60 * 1000;
const MAX_GAP_MS = 30 * 60 * 1000;

export function createRemovalEngine(config, log, getSock, store, getBroadcastJids) {
  const stateFile = path.join(config.botDir, 'removal-state.json');

  let _timeouts = [];
  let _running = false;

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) { log.warn(`⚠️  Removal state read failed: ${err.message}`); }
    return null;
  }

  function saveState(state) {
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    catch (err) { log.error(`❌ Removal state save failed: ${err.message}`); }
  }

  function deleteState() {
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }
    catch (err) { log.warn(`⚠️  Removal state delete failed: ${err.message}`); }
  }

  function clearTimeouts() {
    for (const t of _timeouts) clearTimeout(t);
    _timeouts = [];
  }

  function getRemovalList() {
    const all = store.getAll();
    return all
      .filter(m => {
        const days = daysFromToday(m.billingDate);
        return m.status === 'ACTIVE' && days !== null && days <= -config.overdue.consolidatedListDays;
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  async function notify(text) {
    const sock = getSock();
    if (!sock?.user) return;
    for (const jid of getBroadcastJids()) {
      try { await sock.sendMessage(jid, { text }); }
      catch (err) { log.warn(`⚠️  Kickall notify failed ${jid}: ${err.message}`); }
    }
  }

  async function removeMemberFromAllGroups(phone) {
    const jid = `91${normalizePhone(phone)}@s.whatsapp.net`;
    let removedCount = 0;
    for (let i = 0; i < config.paidGroups.length; i++) {
      const currentSock = getSock();
      if (!currentSock?.user) { log.warn('⚠️  Kickall: socket lost mid-removal'); break; }
      try {
        await currentSock.groupParticipantsUpdate(config.paidGroups[i], [jid], 'remove');
        removedCount++;
        log.info(`🚫 Kickall removed ${phone} from group ${i + 1}/${config.paidGroups.length}`);
      } catch (err) {
        log.warn(`⚠️  Kickall remove failed group ${i + 1}: ${err.message}`);
      }
      if (i < config.paidGroups.length - 1) {
        await sleep(randomBetween(config.rateLimits.groupOpGapMinMs, config.rateLimits.groupOpGapMaxMs));
      }
    }
    return removedCount;
  }

  async function processOneMember(index) {
    if (_running) {
      log.warn(`⚠️  Kickall: overlapping run at index ${index} — skipping`);
      return;
    }
    _running = true;

    try {
      const state = loadState();
      if (!state?.active) return;

      if (index >= state.members.length) {
        await finishKickall(state);
        return;
      }

      if (state.members[index]?.done) {
        state.currentIndex = index + 1;
        saveState(state);
        scheduleNext(index + 1, 0);
        return;
      }

      const sock = getSock();
      if (!sock?.user) {
        log.warn('⚠️  Kickall: socket not ready — will resume on reconnect');
        return;
      }

      const member = state.members[index];
      log.info(`🚫 Kickall [${index + 1}/${state.members.length}]: ${member.name} (${member.phone})`);

      const removedCount = await removeMemberFromAllGroups(member.phone);

      try {
        await store.update(member.phone, { status: 'REMOVED' });
      } catch (err) {
        log.warn(`⚠️  Kickall store update failed [${member.name}]: ${err.message}`);
      }

      state.members[index].done = true;
      state.members[index].removedGroups = removedCount;
      state.currentIndex = index + 1;
      if (removedCount > 0) state.totalRemoved = (state.totalRemoved || 0) + 1;
      saveState(state);

      await notify(
        `🚫 Kickall [${index + 1}/${state.members.length}]: ${member.name} (${member.phone}) — removed from ${removedCount}/${config.paidGroups.length} groups`
      );

      if (index + 1 < state.members.length) {
        const gapMs = randomBetween(MIN_GAP_MS, MAX_GAP_MS);
        const gapMin = Math.round(gapMs / 60000);
        log.info(`⏰ Kickall: next removal in ~${gapMin}min`);
        await notify(`⏰ Next removal in ~${gapMin} min...`);
        scheduleNext(index + 1, gapMs);
      } else {
        await finishKickall(state);
      }
    } finally {
      _running = false;
    }
  }

  function scheduleNext(index, delayMs) {
    if (!loadState()?.active) return;
    const t = setTimeout(() => processOneMember(index), delayMs);
    _timeouts.push(t);
  }

  async function finishKickall(state) {
    clearTimeouts();
    deleteState();
    log.info(`✅ Kickall complete — ${state.totalRemoved}/${state.members.length} removed`);
    await notify(`✅ Kickall complete!\nRemoved: ${state.totalRemoved}/${state.members.length} members.`);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function handleRemoval() {
    const list = getRemovalList();
    if (list.length === 0) return `✅ No members overdue by ${config.overdue.consolidatedListDays}+ days.`;

    const activeState = loadState();
    const lines = list.map((m, i) =>
      `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue}d overdue`
    ).join('\n');

    let msg = `🚫 REMOVAL LIST — ${config.overdue.consolidatedListDays}+ days overdue (${list.length} members):\n\n${lines}\n\n`;
    msg += `Actions:\n• warnall — send final warning to all\n• kickall — bulk removal (15–30 min/person)\n• skip [phone] [reason] — exclude\n• renewed [phone] — mark as paid`;

    if (activeState?.active) {
      const done = activeState.members.filter(m => m.done).length;
      msg += `\n\n⚡ Kickall in progress: ${done}/${activeState.members.length} done`;
    }
    return msg;
  }

  async function warnall() {
    const list = getRemovalList();
    if (list.length === 0) return `✅ No members overdue by ${config.overdue.consolidatedListDays}+ days.`;

    const sock = getSock();
    if (!sock?.user) return '❌ Bot not connected.';

    let sent = 0, failed = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
      const text = config.messages.overdue
        .replace('{name}', m.name)
        .replace('{days}', String(m.daysOverdue));
      try {
        await sock.sendMessage(jid, { text });
        sent++;
        log.info(`📨 Final warning → ${m.name} (${m.phone})`);
      } catch (err) {
        failed++;
        log.warn(`❌ Final warning failed [${m.name}]: ${err.message}`);
      }
      if (i < list.length - 1) {
        await sleep(randomBetween(
          config.rateLimits.memberToMemberGapMinMs,
          config.rateLimits.memberToMemberGapMaxMs
        ));
      }
    }
    return `✅ Final warning sent to ${sent}/${list.length} members${failed > 0 ? ` (${failed} failed)` : ''}`;
  }

  function kickall() {
    const existing = loadState();
    if (existing?.active) return '⚠️ Kickall already running. Send "stop kickall" to cancel.';

    const list = getRemovalList();
    if (list.length === 0) return `✅ No members overdue by ${config.overdue.consolidatedListDays}+ days — nothing to kick.`;

    const state = {
      active: true,
      startedAt: new Date().toISOString(),
      members: list.map(m => ({ name: m.name, phone: m.phone, daysOverdue: m.daysOverdue, done: false })),
      currentIndex: 0,
      totalRemoved: 0,
    };
    saveState(state);
    scheduleNext(0, 0);

    const avgGapMin = Math.round((MIN_GAP_MS + MAX_GAP_MS) / 2 / 60000);
    const estHours = ((list.length - 1) * avgGapMin / 60).toFixed(1);
    const memberList = list.map((m, i) => `  ${i + 1}. ${m.name} (${m.phone}) — ${m.daysOverdue}d overdue`).join('\n');

    return `🚫 Kickall started — ${list.length} members:\n${memberList}\n\nGap: 15–30 min per person\nEst. time: ~${estHours} hrs\nSend "stop kickall" to cancel.`;
  }

  function stopKickall() {
    const state = loadState();
    if (!state?.active) return '❌ No kickall running.';
    clearTimeouts();
    deleteState();
    log.info('🛑 Kickall stopped');
    return '🛑 Kickall stopped. State cleared.';
  }

  function resume() {
    const state = loadState();
    if (!state?.active) return;
    const remaining = state.members.filter(m => !m.done).length;
    if (remaining === 0) { deleteState(); return; }
    // Use a 2-min reconnect grace period instead of 0 to avoid firing immediately
    const delayMs = 2 * 60 * 1000;
    log.info(`🔄 Resuming kickall — ${remaining} pending from index ${state.currentIndex} (starts in 2 min)`);
    scheduleNext(state.currentIndex, delayMs);
  }

  return { handleRemoval, warnall, kickall, stopKickall, resume };
}
