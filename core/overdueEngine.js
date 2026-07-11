import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, isDelayActive, friendlyDate, todayStr, cronTimePassedToday, beforeCatchUpCutoff } from './globalConfig.js';

export function createOverdueEngine(config, log) {
  // ── Per-day state (overdue-state.json) ──────────────────────────────────────
  // Tracks which members already received a day-6/day-7 reminder today and whether the
  // consolidated owner list was sent, so the daily check is idempotent: the cron run and any
  // restart catch-up both share this state and never message the same person (or the owner) twice.
  const stateFile = config.botDir ? path.join(config.botDir, 'overdue-state.json') : null;

  let _running = false;
  let _resumeTimer = null;
  const RESUME_GRACE_MS = 2 * 60 * 1000; // matches removalEngine.resume()

  function freshState() {
    return { date: todayStr(), sentPhones: [], listSent: false, done: false };
  }

  function loadState() {
    try {
      if (stateFile && fs.existsSync(stateFile)) {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (data.date === todayStr()) return data;
      }
    } catch (err) {
      log.warn(`⚠️  Overdue state read failed: ${err.message}`);
    }
    return freshState();
  }

  function saveState(state) {
    if (!stateFile) return;
    try {
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log.error(`❌ Overdue state save failed: ${err.message}`);
    }
  }

  async function runOverdueCheck(store, getSock, broadcastJids) {
    // Single-flight guard: the 10:00 cron and a reconnect catch-up must never run together.
    if (_running) {
      log.warn('⚠️  Overdue check already running — skipping overlap');
      return;
    }
    _running = true;
    try {
      const sock = getSock();
      if (!sock?.user) {
        log.warn('⚠️  Overdue check skipped — socket not ready');
        return;
      }

      const state = loadState();
      const active = store.getActive();

      // Day 6 exactly → auto-send reminder to member
      const day6 = active.filter(m => {
        const d = daysFromToday(m.billingDate);
        return d !== null && d === -config.overdue.autoReminderDays;
      });

      // Final reminder to the member — one day BEFORE removal day (default day-6 when
      // removal is day-7), so they get a full day to pay before the evening removal.
      // Skip delayed.
      const removalDay = config.overdue.consolidatedListDays;
      const finalReminderDay = config.overdue.finalReminderDays ?? (removalDay - 1);
      const finalDay = active.filter(m => {
        const d = daysFromToday(m.billingDate);
        return d !== null && d === -finalReminderDay && !isDelayActive(m);
      });

      // Day 7+ → send consolidated list to owner
      const day7plus = active
        .filter(m => {
          const d = daysFromToday(m.billingDate);
          // Skip members with an active delay — they're hidden from the removal list until it expires.
          return d !== null && d <= -(config.overdue.consolidatedListDays) && !isDelayActive(m);
        })
        .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
        .sort((a, b) => b.daysOverdue - a.daysOverdue);

      log.info(`⚠️  Overdue check: ${day6.length} at day-${config.overdue.autoReminderDays}, ${finalDay.length} at day-${finalReminderDay} (final), ${day7plus.length} at day-${removalDay}+`);

      // Removal-engine-style spacing when dmReminderGap* is configured; bots without
      // it (bot-nitin) keep the original memberToMemberGap pacing.
      const gapMin = config.rateLimits.dmReminderGapMinMs ?? config.rateLimits.memberToMemberGapMinMs;
      const gapMax = config.rateLimits.dmReminderGapMaxMs ?? config.rateLimits.memberToMemberGapMaxMs;

      // Group reminder mode: the day-5 milestone members are tagged in the morning
      // group digest (msg 2) instead of getting a DM here. The FINAL reminder below
      // stays a personal DM in BOTH modes — it's the last-chance personal touch.
      const groupMode = config.reminder?.mode === 'group' && !!config.reminder?.groupId;

      // Send FINAL reminders directly to members (day before removal).
      // Skip anyone already messaged today — makes a restart catch-up safe to re-run.
      const finalTemplate = config.messages.finalReminder || config.messages.overdue;
      for (let i = 0; i < finalDay.length; i++) {
        const m = finalDay[i];
        if (state.sentPhones.includes(m.phone)) continue;
        const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
        const text = finalTemplate
          .replace('{name}', m.name)
          .replace('{days}', String(finalReminderDay))
          .replace('{date}', friendlyDate());

        try {
          await sock.sendMessage(jid, { text });
          state.sentPhones.push(m.phone);
          saveState(state);
          log.info(`📨 Day-${finalReminderDay} FINAL reminder → ${m.name} (${m.phone})`);
        } catch (err) {
          log.warn(`❌ Final reminder failed [${m.name}]: ${err.message}`);
        }

        if (i < finalDay.length - 1) {
          await sleep(randomBetween(gapMin, gapMax));
        }
      }

      // Send day-5 milestone reminders directly to members (deduped per day, same as
      // above) — DM mode only; group mode covers these via the overdue group message.
      for (let i = 0; i < day6.length && !groupMode; i++) {
        const m = day6[i];
        if (state.sentPhones.includes(m.phone)) continue;
        const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
        const text = config.messages.overdue
          .replace('{name}', m.name)
          .replace('{days}', config.overdue.autoReminderDays);

        try {
          await sock.sendMessage(jid, { text });
          state.sentPhones.push(m.phone);
          saveState(state);
          log.info(`📨 Day-${config.overdue.autoReminderDays} overdue reminder → ${m.name} (${m.phone})`);
        } catch (err) {
          log.warn(`❌ Day-${config.overdue.autoReminderDays} reminder failed [${m.name}]: ${err.message}`);
        }

        if (i < day6.length - 1) {
          await sleep(randomBetween(gapMin, gapMax));
        }
      }

      // Send consolidated list to all broadcast JIDs — once per day. listSent guards against a
      // reconnect catch-up re-spamming the owner with the same list.
      if (day7plus.length > 0 && !state.listSent) {
        const listLines = day7plus
          .map((m, i) => `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue`)
          .join('\n');

        const msg = config.messages.overdueConsolidated
          .replace('{count}', day7plus.length)
          .replace('{list}', listLines);

        const jids = Array.isArray(broadcastJids) ? broadcastJids : [broadcastJids];
        let listDelivered = false;
        for (const jid of jids) {
          try {
            await sock.sendMessage(jid, { text: msg });
            listDelivered = true;
            log.info(`📋 Overdue list sent to ${jid} — ${day7plus.length} members`);
          } catch (err) {
            log.warn(`❌ Failed to send overdue list to ${jid}: ${err.message}`);
          }
        }
        if (listDelivered) {
          state.listSent = true;
          saveState(state);
        }
      }

      // Mark the day handled ONLY if everything actually went out — every targeted member is
      // now recorded and the owner list (if any) was sent. A partial run (a send threw, socket
      // dropped mid-batch) leaves done=false so the next reconnect catch-up retries the rest.
      // Group mode never DMs the day-5 milestone set, so only finalDay counts toward done.
      const mustDm = groupMode ? finalDay : [...finalDay, ...day6];
      const allMembersDone = mustDm.every(m => state.sentPhones.includes(m.phone));
      const listDone = day7plus.length === 0 || state.listSent;
      state.done = allMembersDone && listDone;
      saveState(state);
    } finally {
      _running = false;
    }
  }

  // Called on every connection.open (see index.js). If today's overdue window has already
  // elapsed but the check never completed (bot was offline at 10:00, or dropped mid-run), run
  // it now after a short grace. Idempotent via overdue-state.json, so no member/owner is
  // messaged twice. Mirrors removalEngine.resume().
  function resume(store, getSock, getBroadcastJids) {
    if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
    _resumeTimer = setTimeout(() => {
      _resumeTimer = null;
      const state = loadState();
      if (state.done) {
        log.info('⚠️  Overdue catch-up: already completed today — nothing to do');
        return;
      }
      if (!cronTimePassedToday(config.schedule?.overdueCheck)) {
        log.info('⚠️  Overdue catch-up: before today\'s overdue window — letting cron handle it');
        return;
      }
      // Past the morning cutoff (default noon), do NOT replay the overdue check — sending overdue
      // reminders late in the evening is exactly the behaviour we want to avoid. Skip until tomorrow.
      const cutoff = config.catchUpCutoffHour ?? 12;
      if (!beforeCatchUpCutoff(cutoff)) {
        log.info(`⚠️  Overdue catch-up: past the ${cutoff}:00 cutoff — skipping until tomorrow's check`);
        return;
      }
      log.info('⚠️  Overdue catch-up: running missed/incomplete overdue check after restart');
      runOverdueCheck(store, getSock, getBroadcastJids())
        .catch(err => log.warn(`⚠️  Overdue catch-up failed: ${err.message}`));
    }, RESUME_GRACE_MS);
    log.info('⚠️  Overdue catch-up scheduled (2-min grace after reconnect)');
  }

  return { runOverdueCheck, resume };
}
