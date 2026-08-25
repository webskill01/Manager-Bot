import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, resolveWhatsAppJid, isDelayActive } from './globalConfig.js';

const MIN_GAP_MS = 15 * 60 * 1000;
const MAX_GAP_MS = 30 * 60 * 1000;

export function createRemovalEngine(config, log, getSock, store, getBroadcastJids, notifyTelegram = null) {
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
        // Delayed members (paid-promise snooze) stay overdue but are hidden from the removal list.
        return m.status === 'ACTIVE' && days !== null && days <= -config.overdue.consolidatedListDays && !isDelayActive(m);
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  // Telegram first, WhatsApp only as the fallback.
  //
  // These progress notices used to go out as WhatsApp DMs to every admin JID — the exact
  // traffic pattern this project blames for the July ban, and on a bot the operator drives
  // from Telegram it is a WhatsApp send that buys nothing. A bot with no token keeps the old
  // broadcast, so nothing goes quiet on the WhatsApp-only bots.
  async function notify(text) {
    if (notifyTelegram) {
      try { await notifyTelegram(text); return; }
      catch (err) { log.warn(`⚠️  Telegram notify failed, falling back: ${err.message}`); }
    }
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
    let interrupted = false;
    for (let i = 0; i < config.paidGroups.length; i++) {
      const currentSock = getSock();
      if (!currentSock?.user) { log.warn('⚠️  Kickall: socket lost mid-removal'); interrupted = true; break; }
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
    return { removedCount, interrupted };
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

      // Re-validate against the LIVE sheet before removing — between locking the list
      // and reaching this person they may have renewed (billing pushed to future) or had
      // their status changed. Refresh the cache and skip anyone no longer overdue.
      await store.refresh();
      const fresh = store.findByPhone(member.phone);
      const isStillOverdue = (() => {
        if (!fresh || fresh.status !== 'ACTIVE') return false;
        if (isDelayActive(fresh)) return false; // delayed mid-run — skip until the delay expires
        const d = daysFromToday(fresh.billingDate);
        return d !== null && d <= -config.overdue.consolidatedListDays;
      })();

      if (!isStillOverdue) {
        const reason = !fresh ? 'no longer in sheet'
          : fresh.status !== 'ACTIVE' ? `now ${fresh.status}`
          : isDelayActive(fresh) ? `delayed until ${fresh.delayUntil}`
          : 'renewed / no longer overdue';
        log.info(`⏭️  Kickall [${index + 1}/${state.members.length}]: ${member.name} skipped — ${reason}`);
        state.members[index].done = true;
        state.members[index].skipped = true;
        state.currentIndex = index + 1;
        saveState(state);
        await notify(`⏭️ Kickall [${index + 1}/${state.members.length}]: ${member.name} (${member.phone}) skipped — ${reason}`);
        // No WhatsApp op was performed, so proceed to the next person immediately.
        if (index + 1 < state.members.length) scheduleNext(index + 1, 0);
        else await finishKickall(state);
        return;
      }

      log.info(`🚫 Kickall [${index + 1}/${state.members.length}]: ${member.name} (${member.phone})`);

      const { removedCount, interrupted } = await removeMemberFromAllGroups(member.phone);

      // Socket dropped partway through this member's group loop — they were only partially
      // processed. Do NOT mark them done/REMOVED: leave index where it is so resume() retries the
      // full removal on reconnect (re-removing an already-removed group just no-ops). Marking
      // REMOVED here would flag someone still physically in the groups as gone from billing.
      if (interrupted) {
        log.warn(`⚠️  Kickall [${index + 1}/${state.members.length}]: ${member.name} interrupted by socket loss — will retry on reconnect`);
        return;
      }

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

  let _warnRunning = false;

  // Runs in the background with the same multi-minute spacing as reminder DMs
  // (dmReminderGap*, fallback memberToMemberGap*) — the command replies instantly and
  // the admins get a completion summary when the batch finishes.
  async function runWarnBatch(list) {
    let sent = 0, failed = 0;
    const unreachable = [];   // no WhatsApp account on the number
    const failures = [];      // the send threw
    try {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const sock = getSock();   // re-fetch each member — the batch can span an hour+
        if (!sock?.user) {
          failed++;
          log.warn(`⚠️  Socket not ready — final warning skipped for ${m.name}`);
        } else {
          // Resolved, not assembled — a phone JID we built ourselves is a guess, and a
          // LID-primary account swallows it without error. See resolveWhatsAppJid.
          let jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
          let dead = false;
          try {
            const found = await resolveWhatsAppJid(sock, m.phone);
            if (found.exists) jid = found.jid;
            else dead = true;
          } catch (err) {
            log.warn(`⚠️  JID lookup failed for ${m.phone} — using the phone JID: ${err.message}`);
          }

          if (dead) {
            failed++;
            unreachable.push(`${m.name} ${m.phone}`);
            log.warn(`📵 ${m.name} (${m.phone}) is not on WhatsApp — final warning not sent`);
          } else {
            const text = config.messages.overdue
              .replace('{name}', m.name)
              .replace('{days}', String(m.daysOverdue));
            try {
              await sock.sendMessage(jid, { text });
              sent++;
              log.info(`📨 Final warning → ${m.name} (${m.phone})`);
            } catch (err) {
              failed++;
              failures.push(`${m.name} ${m.phone} — ${err.message}`);
              log.warn(`❌ Final warning failed [${m.name}]: ${err.message}`);
            }
          }
        }
        if (i < list.length - 1) {
          const gap = randomBetween(
            config.rateLimits.dmReminderGapMinMs ?? config.rateLimits.memberToMemberGapMinMs,
            config.rateLimits.dmReminderGapMaxMs ?? config.rateLimits.memberToMemberGapMaxMs
          );
          log.info(`⏳ Next warning in ${(gap / 1000).toFixed(0)}s`);
          await sleep(gap);
        }
      }
      // Named, not just counted. "3 failed" tells the operator something is wrong and
      // nothing about what to do; the names are what they act on.
      await notify(
        `✅ warnall done: ${sent}/${list.length} warned${failed > 0 ? ` (${failed} failed)` : ''}` +
        (unreachable.length > 0
          ? `\n\n📵 *Not on WhatsApp* (${unreachable.length}):\n${unreachable.join('\n')}`
          : '') +
        (failures.length > 0
          ? `\n\n⚠️ *Send failed* (${failures.length}):\n${failures.join('\n')}`
          : ''));
    } finally {
      _warnRunning = false;
    }
  }

  function warnall() {
    const list = getRemovalList();
    if (list.length === 0) return `✅ No members overdue by ${config.overdue.consolidatedListDays}+ days.`;
    if (!getSock()?.user) return '❌ Bot not connected.';
    if (_warnRunning) return '⚠️ warnall already running — wait for the completion summary.';

    _warnRunning = true;
    runWarnBatch(list).catch(err => { log.error(`❌ warnall batch failed: ${err.message}`); _warnRunning = false; });

    const gapMaxMin = (config.rateLimits.dmReminderGapMaxMs ?? config.rateLimits.memberToMemberGapMaxMs) / 60000;
    const etaMin = Math.ceil((list.length - 1) * gapMaxMin);
    return `📨 Sending final warnings to ${list.length} members with spaced gaps — done within ~${Math.max(etaMin, 1)} min. Summary will follow.`;
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
    // resume() fires on EVERY reconnect (connection.open). A removal mid-flight will schedule the
    // next member itself when it finishes, so do nothing here — stacking another chain would run
    // two removals in parallel and collapse the 15–30 min anti-ban gap (ban risk).
    if (_running) {
      log.info('🔄 Kickall resume skipped — a removal is already in progress');
      return;
    }
    // Not running → we may be sitting in a gap timer. Cancel any pending chain before re-arming so
    // repeated reconnects can never leave two parallel chains advancing through the list.
    clearTimeouts();
    // Use a 2-min reconnect grace period instead of 0 to avoid firing immediately
    const delayMs = 2 * 60 * 1000;
    log.info(`🔄 Resuming kickall — ${remaining} pending from index ${state.currentIndex} (starts in 2 min)`);
    scheduleNext(state.currentIndex, delayMs);
  }

  return { handleRemoval, warnall, kickall, stopKickall, resume };
}
