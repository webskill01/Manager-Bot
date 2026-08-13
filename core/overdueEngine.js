import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, isDelayActive, friendlyDate, todayStr, cronTimePassedToday, beforeCatchUpCutoff } from './globalConfig.js';
import { buildGroupDigest } from './reminderSender.js';
import { usesCloudApi, createCloudApiSender } from './cloudApiSender.js';

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

      // Group reminder mode: day-5 milestone members are tagged in the morning group
      // digest (msg 2) instead of getting a DM here, and since 2026-07-27 the FINAL
      // reminder is group-tagged too. It used to stay a personal DM in both modes, which
      // meant "group mode" still sent proactive payment-demand DMs — the single strongest
      // ban signal — so group mode was never the DM kill-switch it appeared to be.
      // Cloud API (reminderChannel: "cloudapi") is where a private final reminder belongs:
      // there it cannot get the number banned. Once it is on it outranks group mode for
      // BOTH stages — group tagging exists only because private DMs were unsafe, and the
      // official API is the thing that made them safe again.
      const cloud = usesCloudApi(config);
      const groupMode = !cloud && config.reminder?.mode === 'group' && !!config.reminder?.groupId;

      // Send FINAL reminders (day before removal).
      // Skip anyone already messaged today — makes a restart catch-up safe to re-run.
      const pendingFinal = finalDay.filter(m => !state.sentPhones.includes(m.phone));

      // Official Cloud API, both stages. A failure here does NOT fall back to a Baileys DM:
      // that fallback would send the exact proactive payment-demand message this whole
      // channel exists to stop, and it would do it precisely when something is already
      // wrong (dead token, unfunded balance) — i.e. for EVERY member at once, not one.
      // Failures are recorded and reported instead; the operator sends those by hand
      // with `dmlist`, which is why that command is kept.
      if (cloud && pendingFinal.length > 0) {
        const sender = createCloudApiSender(config, log);
        const failed = [];
        for (const m of pendingFinal) {
          const result = await sender.sendTemplate({
            type: 'finalReminder',
            bodyParams: [m.name, String(finalReminderDay), friendlyDate()],
            phone: m.phone,
          });
          if (result.ok) {
            state.sentPhones.push(m.phone);
            (state.sends ??= []).push({
              phone: m.phone, name: m.name, type: 'finalReminder',
              messageId: result.messageId || null, at: new Date().toISOString(),
            });
          } else {
            failed.push(m);
            (state.failures ??= []).push({
              phone: m.phone, name: m.name, type: 'finalReminder',
              error: result.error || 'unknown', code: result.code ?? null, at: new Date().toISOString(),
            });
          }
          saveState(state);
          await sleep(randomBetween(1000, 3000));
        }
        if (failed.length > 0) {
          log.error(`❌ Cloud API failed for ${failed.length} FINAL reminder(s): ${failed.map(m => `${m.name} ${m.phone}`).join(', ')}`);
          log.error('   These are one day from removal and were NOT reminded. Send by hand: dmlist');
        }
        // Nothing falls through to the group/DM blocks below on this channel.
        pendingFinal.length = 0;
      }

      if (groupMode && pendingFinal.length > 0) {
        // One tagged group message for everyone at the final milestone.
        let participants = [];
        try {
          const meta = await sock.groupMetadata(config.reminder.groupId);
          participants = meta?.participants || [];
        } catch (err) {
          log.warn(`⚠️  Final reminder groupMetadata failed: ${err.message} — sending without tags`);
        }
        const header = (config.messages.groupFinal || config.messages.groupOverdue || '🚨 Last day before removal — please repay')
          .replace('{date}', friendlyDate())
          .replace('{days}', String(finalReminderDay));
        const { text, mentions } = buildGroupDigest({
          header,
          members: pendingFinal.map(m => ({ name: m.name, phone: m.phone, note: `— ${Math.abs(daysFromToday(m.billingDate))} din overdue` })),
          participants,
        });
        try {
          await sock.sendMessage(config.reminder.groupId, { text, mentions });
          for (const m of pendingFinal) state.sentPhones.push(m.phone);
          saveState(state);
          log.info(`📨 Day-${finalReminderDay} FINAL reminder → group, ${pendingFinal.length} member(s) tagged`);
        } catch (err) {
          log.warn(`❌ Group final reminder failed: ${err.message}`);
        }
      } else if (pendingFinal.length > 0) {
        const finalTemplate = config.messages.finalReminder || config.messages.overdue;
        for (let i = 0; i < pendingFinal.length; i++) {
          const m = pendingFinal[i];
          const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
          const text = finalTemplate
            .replace('{name}', m.name)
            .replace('{days}', String(finalReminderDay))
            .replace('{date}', friendlyDate(m.billingDate));

          try {
            await sock.sendMessage(jid, { text });
            state.sentPhones.push(m.phone);
            saveState(state);
            log.info(`📨 Day-${finalReminderDay} FINAL reminder → ${m.name} (${m.phone})`);
          } catch (err) {
            log.warn(`❌ Final reminder failed [${m.name}]: ${err.message}`);
          }

          if (i < pendingFinal.length - 1) {
            await sleep(randomBetween(gapMin, gapMax));
          }
        }
      }

      // Send day-5 milestone reminders directly to members (deduped per day, same as
      // above) — private-reminder modes only; group mode covers these via the overdue
      // group message. On the Cloud API this is a template send and never touches the
      // socket, so it keeps working after a 403; on Baileys it is the original DM.
      const day5Pending = groupMode ? [] : day6.filter(m => !state.sentPhones.includes(m.phone));
      const day5Sender = cloud && day5Pending.length > 0 ? createCloudApiSender(config, log) : null;

      for (let i = 0; i < day5Pending.length; i++) {
        const m = day5Pending[i];

        if (cloud) {
          const result = await day5Sender.sendTemplate({
            type: 'overdue',
            bodyParams: [m.name, String(config.overdue.autoReminderDays)],
            phone: m.phone,
          });
          if (result.ok) {
            state.sentPhones.push(m.phone);
            (state.sends ??= []).push({
              phone: m.phone, name: m.name, type: 'overdue',
              messageId: result.messageId || null, at: new Date().toISOString(),
            });
            log.info(`📨 Day-${config.overdue.autoReminderDays} overdue reminder → ${m.name} (${m.phone})`);
          } else {
            (state.failures ??= []).push({
              phone: m.phone, name: m.name, type: 'overdue',
              error: result.error || 'unknown', code: result.code ?? null, at: new Date().toISOString(),
            });
            log.warn(`❌ Day-${config.overdue.autoReminderDays} reminder failed [${m.name}]: ${result.error}`);
          }
          saveState(state);
          // Meta's own API needs none of the anti-ban pacing — a short, even gap is only
          // there to stay well inside the per-second rate limit.
          if (i < day5Pending.length - 1) await sleep(randomBetween(1000, 3000));
          continue;
        }

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

        if (i < day5Pending.length - 1) {
          await sleep(randomBetween(gapMin, gapMax));
        }
      }

      // The consolidated removal list used to be DM'd to every admin here, once a day.
      // Removed 2026-07-27 along with the morning/evening digests: an unprompted daily DM
      // to admins is the same traffic pattern that got a fresh number banned, and the
      // list was never urgent — it's a work queue, not an alert. Pull it on demand with
      // the `removal` command (same 7+ day list) or `overdue` (which also arms the
      // R1/S2/W3 batch actions). Logged so it's still visible in pm2 logs.
      if (day7plus.length > 0) {
        log.info(`📋 ${day7plus.length} member(s) at day-${removalDay}+ — run "removal" to see the list`);
      }

      // Mark the day handled ONLY if every targeted member is now recorded. A partial run
      // (a send threw, socket dropped mid-batch) leaves done=false so the next reconnect
      // catch-up retries the rest. Group mode never DMs the day-5 milestone set, so only
      // finalDay counts toward done.
      const mustDm = groupMode ? finalDay : [...finalDay, ...day6];
      state.done = mustDm.every(m => state.sentPhones.includes(m.phone));
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
