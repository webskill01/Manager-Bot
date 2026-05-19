import fs from 'fs';
import path from 'path';
import { randomBetween, sleep, normalizePhone } from './globalConfig.js';

export function createTrialRemovalEngine(config, log, getSock, getBroadcastJids) {
  const stateFile = path.join(config.botDir, 'trial-state.json');
  const tc = config.trial;

  let _timeouts = [];
  let _running = false;

  // ── State helpers ─────────────────────────────────────────────────────────

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) { log.warn(`⚠️  Trial state read failed: ${err.message}`); }
    return null;
  }

  function saveState(state) {
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    catch (err) { log.error(`❌ Trial state save failed: ${err.message}`); }
  }

  function deleteState() {
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }
    catch (err) { log.warn(`⚠️  Trial state delete failed: ${err.message}`); }
  }

  function clearTimeouts() {
    for (const t of _timeouts) clearTimeout(t);
    _timeouts = [];
  }

  // ── Whitelist matching ────────────────────────────────────────────────────
  // Phone JID (91XXXXXXXXXX@s.whatsapp.net) → normalize to 10 digits → check trial.whitelist
  // LID JID (XXXXXXXXX:XX@lid)              → check numeric prefix against config.allowedLids
  // Anything else                           → treat as protected (never remove)

  function isWhitelisted(jid) {
    if (jid.endsWith('@s.whatsapp.net')) {
      const digits = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      const phone10 = normalizePhone(digits);
      return (tc.whitelist || []).some(w => normalizePhone(w) === phone10);
    }
    if (jid.endsWith('@lid')) {
      const rawLid = jid.replace('@lid', '').split(':')[0];
      return (config.allowedLids || []).some(lid => String(lid).split(':')[0] === rawLid);
    }
    return true;
  }

  // ── Message sending ───────────────────────────────────────────────────────

  async function sendBatchMessages() {
    const sock = getSock();
    if (!sock?.user) throw new Error('Socket not connected');
    const groupJid = tc.groupId;

    await sock.sendMessage(groupJid, { text: tc.messages.warningText });
    await sleep(randomBetween(3000, 5000));

    const hasVideo = !!tc.messages.video?.path;
    const useVideo = hasVideo && Math.random() < 0.5;

    if (useVideo) {
      const videoBuffer = fs.readFileSync(path.resolve(config.botDir, tc.messages.video.path));
      await sock.sendMessage(groupJid, { video: videoBuffer, caption: tc.messages.video.caption || '' });
    } else {
      const imageBuffer = fs.readFileSync(path.resolve(config.botDir, tc.messages.image.path));
      await sock.sendMessage(groupJid, { image: imageBuffer, caption: tc.messages.image.caption || '' });
    }
    await sleep(randomBetween(2000, 4000));
  }

  // ── Batch execution ───────────────────────────────────────────────────────

  async function runBatch(batchIndex) {
    if (_running) {
      log.warn(`⚠️  Trial batch ${batchIndex + 1} skipped — another batch still running`);
      return;
    }
    _running = true;

    try {
      const sock = getSock();
      if (!sock?.user) {
        log.warn(`⚠️  Trial batch ${batchIndex + 1} skipped — socket not connected`);
        return;
      }

      log.info(`🚀 Trial removal batch ${batchIndex + 1} starting`);

      let metadata;
      try {
        metadata = await sock.groupMetadata(tc.groupId);
      } catch (err) {
        log.error(`❌ Trial group metadata failed: ${err.message}`);
        return;
      }

      const removable = (metadata.participants || []).filter(p => !isWhitelisted(p.jid));

      if (removable.length === 0) {
        log.info('✅ Trial group clear — only whitelisted members remain');
        const state = loadState();
        if (state) { state.batches[batchIndex].done = true; saveState(state); }
        await notifyCompletion(state?.totalRemoved || 0);
        clearTimeouts();
        deleteState();
        return;
      }

      try {
        await sendBatchMessages();
      } catch (err) {
        log.warn(`⚠️  Batch messages failed (continuing with removal): ${err.message}`);
      }

      const batchSize = Math.min(tc.batchSize || 10, removable.length);
      const toRemove = [...removable].sort(() => Math.random() - 0.5).slice(0, batchSize);

      let removed = 0;
      for (let i = 0; i < toRemove.length; i++) {
        const currentSock = getSock();
        if (!currentSock?.user) { log.warn('⚠️  Socket lost mid-batch — stopping'); break; }
        try {
          await currentSock.groupParticipantsUpdate(tc.groupId, [toRemove[i].jid], 'remove');
          removed++;
          log.info(`🚫 Trial removed: ${toRemove[i].jid}`);
        } catch (err) {
          log.warn(`⚠️  Remove failed ${toRemove[i].jid}: ${err.message}`);
        }
        if (i < toRemove.length - 1) {
          await sleep(randomBetween(config.rateLimits.groupOpGapMinMs, config.rateLimits.groupOpGapMaxMs));
        }
      }

      // Mark done only after all removals finish
      const state = loadState();
      if (state) {
        state.batches[batchIndex].done = true;
        state.totalRemoved = (state.totalRemoved || 0) + removed;
        saveState(state);
      }
      log.info(`✅ Trial batch ${batchIndex + 1} done — removed ${removed}`);

      // Check if group is fully clear after this batch
      try {
        const fresh = await getSock()?.groupMetadata(tc.groupId);
        const remaining = (fresh?.participants || []).filter(p => !isWhitelisted(p.jid));
        if (remaining.length === 0) {
          log.info('✅ Trial group fully cleared');
          await notifyCompletion(state?.totalRemoved || removed);
          clearTimeouts();
          deleteState();
        }
      } catch (err) {
        log.warn(`⚠️  Post-batch check failed: ${err.message}`);
      }

    } finally {
      _running = false;
    }
  }

  // ── Admin notification ────────────────────────────────────────────────────

  async function notifyCompletion(totalRemoved) {
    const sock = getSock();
    if (!sock?.user) return;
    const msg = `✅ Trial removal cycle complete.\nTotal removed this cycle: ${totalRemoved} members.\nGroup is clear — ready for next round of links.`;
    for (const jid of getBroadcastJids()) {
      try { await sock.sendMessage(jid, { text: msg }); }
      catch (err) { log.warn(`⚠️  Completion notify failed ${jid}: ${err.message}`); }
    }
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  function scheduleFromState(state) {
    clearTimeouts();
    const now = Date.now();
    let overdueCount = 0;

    for (let i = 0; i < state.batches.length; i++) {
      if (state.batches[i].done) continue;

      const scheduledAt = new Date(state.batches[i].scheduledAt).getTime();
      const delay = Math.max(0, scheduledAt - now);

      // Overdue batches staggered 5 min apart so they don't overlap
      let effectiveDelay;
      if (delay === 0) {
        effectiveDelay = overdueCount * 5 * 60 * 1000;
        overdueCount++;
        log.info(`⚡ Trial batch ${i + 1} overdue — running in ${Math.round(effectiveDelay / 60000)}min`);
      } else {
        effectiveDelay = delay;
        const timeStr = new Date(scheduledAt).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
        });
        log.info(`⏰ Trial batch ${i + 1} scheduled at ${timeStr}`);
      }

      const t = setTimeout(() => runBatch(i), effectiveDelay);
      _timeouts.push(t);
    }
  }

  function generateBatchTimes(count) {
    const now = Date.now();
    const windowMs   = 23 * 60 * 60 * 1000;  // 23hr window
    const minFirstMs = 20 * 60 * 1000;         // first batch ≥ 20 min from now
    const minGapMs   = 90 * 60 * 1000;         // ≥ 90 min between batches

    const times = [];
    let earliest = now + minFirstMs;
    const deadline = now + windowMs;

    for (let i = 0; i < count; i++) {
      const remaining = count - i;
      const latest = deadline - (remaining - 1) * minGapMs;
      const range = Math.max(0, latest - earliest);
      const t = earliest + Math.random() * range;
      times.push(t);
      earliest = t + minGapMs;
    }
    return times;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function start() {
    if (!tc?.groupId) return '❌ trial.groupId not set in config.json.';

    const existing = loadState();
    if (existing?.active) {
      return '⚠️ Removal cycle already running. Send "stop removal" to cancel first.';
    }

    const count = randomBetween(tc.batchesPerDay?.min ?? 3, tc.batchesPerDay?.max ?? 5);
    const times = generateBatchTimes(count);
    const state = {
      active: true,
      startedAt: new Date().toISOString(),
      batches: times.map(t => ({ scheduledAt: new Date(t).toISOString(), done: false })),
      totalRemoved: 0,
    };

    saveState(state);
    scheduleFromState(state);

    const timeLabels = state.batches.map((b, i) => {
      const d = new Date(b.scheduledAt);
      const t = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      return `  ${i + 1}. ${t}`;
    }).join('\n');

    return `✅ Trial removal started — ${count} batches today:\n${timeLabels}\n\nEach batch sends warning + media then removes ~${tc.batchSize || 10} random members.\nSend "stop removal" to cancel.`;
  }

  function stopCommand() {
    const state = loadState();
    if (!state?.active) return '❌ No active removal cycle running.';
    clearTimeouts();
    deleteState();
    log.info('🛑 Trial removal stopped by command');
    return '🛑 Trial removal stopped. State cleared.';
  }

  // Called on every connection.open — idempotent, reschedules from state file
  function resume() {
    const state = loadState();
    if (!state?.active) return;
    const pending = state.batches.filter(b => !b.done).length;
    if (pending === 0) { deleteState(); return; }
    log.info(`🔄 Resuming trial removal — ${pending} batch(es) pending`);
    scheduleFromState(state);
  }

  return { start, stopCommand, resume };
}
