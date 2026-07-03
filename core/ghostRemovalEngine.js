import fs from 'fs';
import path from 'path';
import { sleep, randomBetween, normalizePhone } from './globalConfig.js';

const MIN_GAP_MS = 15 * 60 * 1000;
const MAX_GAP_MS = 30 * 60 * 1000;

// Bulk-removes "ghosts" — numbers present in the WhatsApp groups but absent from
// the sheet (and not admins / the bot). Modeled on removalEngine: one person at a
// time, 15–30 min gaps, state persisted to disk, resumes across reconnects.
export function createGhostRemovalEngine(config, log, getSock, store, getBroadcastJids) {
  const stateFile = path.join(config.botDir, 'ghost-removal-state.json');

  let _timeouts = [];
  let _running = false;
  let _starting = false; // synchronous guard: start() awaits a multi-second scan before saving
                         // state, so two quick "kickghosts confirm" messages must not both launch.

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) { log.warn(`⚠️  Ghost state read failed: ${err.message}`); }
    return null;
  }

  function saveState(state) {
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    catch (err) { log.error(`❌ Ghost state save failed: ${err.message}`); }
  }

  function deleteState() {
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }
    catch (err) { log.warn(`⚠️  Ghost state delete failed: ${err.message}`); }
  }

  function clearTimeouts() {
    for (const t of _timeouts) clearTimeout(t);
    _timeouts = [];
  }

  // Numbers never treated as ghosts: command senders, group owners, the bot itself.
  function excludeSet() {
    const s = new Set([
      ...(config.allowedNumbers || []),
      ...(config.auditExclude || []),
    ].map(normalizePhone));
    const self = (getSock()?.user?.id || '').split(':')[0].replace(/\D/g, '');
    if (self) s.add(normalizePhone(self));
    return s;
  }

  // Scan every group → unique phones present in a group but not in the sheet.
  async function computeGhosts() {
    const sock = getSock();
    if (!sock?.user) throw new Error('Bot not connected');
    await store.refresh();
    const sheetPhones = new Set(store.getAll().map(m => normalizePhone(m.phone)));
    const exclude = excludeSet();
    const ghosts = new Map(); // phone10 -> group count
    const errors = [];

    for (let i = 0; i < config.paidGroups.length; i++) {
      let meta;
      try {
        meta = await sock.groupMetadata(config.paidGroups[i]);
      } catch (err) {
        errors.push(i + 1);
        log.warn(`⚠️  Ghost scan failed group ${i + 1}: ${err.message}`);
        continue;
      }
      for (const p of (meta.participants || [])) {
        // LID-addressed groups report p.id as @lid; the paired phone JID rides on p.phoneNumber
        const jid = p.phoneNumber || p.jid || p.id || '';
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        const ph = normalizePhone(jid.replace('@s.whatsapp.net', '').replace(/\D/g, ''));
        if (!ph || ph.length < 10) continue;
        if (sheetPhones.has(ph) || exclude.has(ph)) continue;
        ghosts.set(ph, (ghosts.get(ph) || 0) + 1);
      }
      if (i < config.paidGroups.length - 1) await sleep(1200);
    }
    return { phones: [...ghosts.keys()], errors };
  }

  async function notify(text) {
    const sock = getSock();
    if (!sock?.user) return;
    for (const jid of getBroadcastJids()) {
      try { await sock.sendMessage(jid, { text }); }
      catch (err) { log.warn(`⚠️  Ghost notify failed ${jid}: ${err.message}`); }
    }
  }

  async function removeFromAllGroups(phone) {
    const jid = `91${normalizePhone(phone)}@s.whatsapp.net`;
    let removedCount = 0;
    let interrupted = false;
    for (let i = 0; i < config.paidGroups.length; i++) {
      const sock = getSock();
      if (!sock?.user) { log.warn('⚠️  Ghost kick: socket lost mid-removal'); interrupted = true; break; }
      try {
        await sock.groupParticipantsUpdate(config.paidGroups[i], [jid], 'remove');
        removedCount++;
        log.info(`🚫 Ghost removed ${phone} from group ${i + 1}/${config.paidGroups.length}`);
      } catch (err) {
        log.warn(`⚠️  Ghost remove failed group ${i + 1}: ${err.message}`);
      }
      if (i < config.paidGroups.length - 1) {
        await sleep(randomBetween(config.rateLimits.groupOpGapMinMs, config.rateLimits.groupOpGapMaxMs));
      }
    }
    return { removedCount, interrupted };
  }

  async function processOne(index) {
    if (_running) {
      log.warn(`⚠️  Ghost kick: overlapping run at index ${index} — skipping`);
      return;
    }
    _running = true;

    try {
      const state = loadState();
      if (!state?.active) return;

      if (index >= state.phones.length) { await finish(state); return; }

      if (state.phones[index]?.done) {
        state.currentIndex = index + 1;
        saveState(state);
        scheduleNext(index + 1, 0);
        return;
      }

      const sock = getSock();
      if (!sock?.user) {
        log.warn('⚠️  Ghost kick: socket not ready — will resume on reconnect');
        return;
      }

      const entry = state.phones[index];

      // Re-validate against the live sheet — someone may have been added (addsilent)
      // between locking the list and reaching them. If now in the sheet, skip.
      await store.refresh();
      if (store.findByPhone(entry.phone)) {
        log.info(`⏭️  Ghost kick [${index + 1}/${state.phones.length}]: ${entry.phone} skipped — now in sheet`);
        state.phones[index].done = true;
        state.phones[index].skipped = true;
        state.currentIndex = index + 1;
        saveState(state);
        await notify(`⏭️ Ghost kick [${index + 1}/${state.phones.length}]: ${entry.phone} skipped — now in sheet`);
        if (index + 1 < state.phones.length) scheduleNext(index + 1, 0);
        else await finish(state);
        return;
      }

      log.info(`🚫 Ghost kick [${index + 1}/${state.phones.length}]: ${entry.phone}`);
      const { removedCount, interrupted } = await removeFromAllGroups(entry.phone);

      // Socket dropped partway through this number's group loop — only partially removed. Don't
      // mark done: leave the index put so resume() retries the full removal on reconnect
      // (re-removing an already-removed group just no-ops). Marking done would strand a ghost in
      // the groups it wasn't removed from until the operator manually re-runs kickghosts.
      if (interrupted) {
        log.warn(`⚠️  Ghost kick [${index + 1}/${state.phones.length}]: ${entry.phone} interrupted by socket loss — will retry on reconnect`);
        return;
      }

      state.phones[index].done = true;
      state.phones[index].removedGroups = removedCount;
      state.currentIndex = index + 1;
      if (removedCount > 0) state.totalRemoved = (state.totalRemoved || 0) + 1;
      saveState(state);

      await notify(`🚫 Ghost kick [${index + 1}/${state.phones.length}]: ${entry.phone} — removed from ${removedCount}/${config.paidGroups.length} groups`);

      if (index + 1 < state.phones.length) {
        const gapMs = randomBetween(MIN_GAP_MS, MAX_GAP_MS);
        const gapMin = Math.round(gapMs / 60000);
        log.info(`⏰ Ghost kick: next removal in ~${gapMin}min`);
        await notify(`⏰ Next ghost removal in ~${gapMin} min...`);
        scheduleNext(index + 1, gapMs);
      } else {
        await finish(state);
      }
    } finally {
      _running = false;
    }
  }

  function scheduleNext(index, delayMs) {
    if (!loadState()?.active) return;
    const t = setTimeout(() => processOne(index), delayMs);
    _timeouts.push(t);
  }

  async function finish(state) {
    clearTimeouts();
    deleteState();
    log.info(`✅ Ghost kick complete — ${state.totalRemoved}/${state.phones.length} removed`);
    await notify(`✅ Ghost removal complete!\nRemoved: ${state.totalRemoved || 0}/${state.phones.length} ghosts.`);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Confirm step — scans live, locks the list, and starts background removal.
  async function start() {
    if (loadState()?.active || _starting) return '⚠️ Ghost removal already running. Send "stop kickghosts" to cancel.';

    const sock = getSock();
    if (!sock?.user) return '❌ Bot not connected.';

    _starting = true;
    try {
      const { phones, errors } = await computeGhosts();
      if (phones.length === 0) {
        return errors.length
          ? `✅ No ghosts found, but ${errors.length} group(s) failed to scan — re-run later to be sure.`
          : '✅ No ghosts found — every member is in the sheet.';
      }

      const state = {
        active: true,
        startedAt: new Date().toISOString(),
        phones: phones.map(phone => ({ phone, done: false })),
        currentIndex: 0,
        totalRemoved: 0,
      };
      saveState(state);
      scheduleNext(0, 0);

      const avgGapMin = Math.round((MIN_GAP_MS + MAX_GAP_MS) / 2 / 60000);
      const estHours = ((phones.length - 1) * avgGapMin / 60).toFixed(1);
      let msg = `🚫 Ghost removal started — ${phones.length} number(s).\n`;
      msg += `Gap: 15–30 min per person\nEst. time: ~${estHours} hrs\n`;
      if (errors.length) msg += `⚠️ ${errors.length} group(s) failed to scan — those members not counted.\n`;
      msg += `Send "stop kickghosts" to cancel.`;
      return msg;
    } finally {
      _starting = false;
    }
  }

  function stop() {
    const state = loadState();
    if (!state?.active) return '❌ No ghost removal running.';
    clearTimeouts();
    deleteState();
    log.info('🛑 Ghost removal stopped');
    return '🛑 Ghost removal stopped. State cleared.';
  }

  function status() {
    const state = loadState();
    if (!state?.active) return null;
    const done = state.phones.filter(p => p.done).length;
    return { done, total: state.phones.length };
  }

  function resume() {
    const state = loadState();
    if (!state?.active) return;
    const remaining = state.phones.filter(p => !p.done).length;
    if (remaining === 0) { deleteState(); return; }
    // resume() fires on EVERY reconnect (connection.open). A removal mid-flight schedules the next
    // itself, so do nothing — stacking another chain would run two removals in parallel and
    // collapse the 15–30 min anti-ban gap (ban risk).
    if (_running) {
      log.info('🔄 Ghost removal resume skipped — a removal is already in progress');
      return;
    }
    // Not running → we may be sitting in a gap timer. Cancel any pending chain before re-arming so
    // repeated reconnects can never leave two parallel chains advancing through the list.
    clearTimeouts();
    const delayMs = 2 * 60 * 1000;
    log.info(`🔄 Resuming ghost removal — ${remaining} pending from index ${state.currentIndex} (starts in 2 min)`);
    scheduleNext(state.currentIndex, delayMs);
  }

  return { start, stop, status, resume };
}
