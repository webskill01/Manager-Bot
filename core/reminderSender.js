import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, todayStr, parseDate, formatDate, formatDateTime, getReferralsInBillingPeriod, friendlyDate, clampedBillingDate, renewedOn, pickSurplusReferrals, surplusCreditDate, cronTimePassedToday, beforeCatchUpCutoff } from './globalConfig.js';

// ── Reminder day-state (reminder-state.json) ──────────────────────────────────
// Module-level so the `renewed` command can mark a phone as already-handled today
// (markPhoneReminded) without holding a reminderSender instance.
function loadState(botDir) {
  const stateFile = path.join(botDir, 'reminder-state.json');
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (data.date === todayStr()) return data;
    }
  } catch {}
  return { date: todayStr(), sentPhones: [] };
}

function saveState(botDir, state) {
  const stateFile = path.join(botDir, 'reminder-state.json');
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, stateFile);
}

// Record `phone` in today's reminder state so neither batch will target it today.
// Called by the `renewed` command so a same-day renewal can never trigger a reminder,
// even if billing math or the store refresh ever regresses.
export function markPhoneReminded(botDir, phone) {
  try {
    const state = loadState(botDir);
    if (!state.sentPhones.includes(phone)) {
      state.sentPhones.push(phone);
      saveState(botDir, state);
    }
  } catch {}
}

export function createReminderSender(config, log) {
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let circuitOpenAt = null;

  // Single-flight lock shared by both cron batches and the restart catch-up, so a reconnect
  // landing on a scheduled-send time can never run two batches at once (which could double-send
  // before sentPhones is persisted). Mirrors removalEngine's _running guard.
  let _busy = false;
  let _resumeTimer = null;
  const RESUME_GRACE_MS = 2 * 60 * 1000; // 2-min reconnect grace, matches removalEngine.resume()
  const NOOP_RESULT = { sent: 0, referralSent: 0, autoRenewed: [], failed: 0, queued: 0 };

  function checkCircuit() {
    if (!circuitOpen) return false;
    if (Date.now() - circuitOpenAt > config.rateLimits.circuitBreakerCooldownMs) {
      circuitOpen = false;
      consecutiveFailures = 0;
      log.info('⚡ Circuit breaker reset');
      return false;
    }
    return true;
  }

  async function sendToMember(getSock, phone, name, botDir, type = 'normal') {
    if (checkCircuit()) {
      log.warn(`⚡ Circuit open — skipping ${name}`);
      return false;
    }

    const sock = getSock();
    if (!sock?.user) {
      log.warn(`⚠️  Socket not ready — skipping ${name}`);
      return false;
    }

    const jid = `91${normalizePhone(phone)}@s.whatsapp.net`;
    const template = type === 'referral' && config.messages.referralReminder
      ? config.messages.referralReminder
      : config.messages.reminder;
    const caption = template.replace('{name}', name).replace('{date}', friendlyDate());

    try {
      const qrPath = path.resolve(botDir, config.upiQrPath);
      if (config.upiQrPath && fs.existsSync(qrPath)) {
        const image = fs.readFileSync(qrPath);
        await sock.sendMessage(jid, { image, caption });
      } else {
        await sock.sendMessage(jid, { text: caption });
      }
      log.info(`📨 Reminder sent (${type}): ${name} (${phone})`);
      consecutiveFailures = 0;
      return true;
    } catch (err) {
      consecutiveFailures++;
      log.warn(`❌ Reminder failed [${name}]: ${err.message}`);
      if (consecutiveFailures >= config.rateLimits.circuitBreakerThreshold) {
        circuitOpen = true;
        circuitOpenAt = Date.now();
        log.error(`⚡ Circuit breaker OPEN — ${consecutiveFailures} consecutive failures`);
      }
      return false;
    }
  }

  async function runBatch(members, getSock, botDir, state, label, store) {
    const all = store.getAll();
    let sent = 0, referralSent = 0, failed = 0;
    const autoRenewed = [];

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const refList = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
      const refs = refList.length;

      if (refs >= 2) {
        try {
          const billing = parseDate(m.billingDate);
          const newBillingDate = formatDate(
            clampedBillingDate(billing.getFullYear(), billing.getMonth() + 1, billing.getDate())
          );
          await store.update(m.phone, {
            status: 'ACTIVE',
            billingDate: newBillingDate,
            renewals: (m.renewals || 0) + 1,
            paidLast: 0,
            lastRenewed: formatDateTime(new Date()),
          });

          // Referral rollover: 2 refs pay for this free renewal; any surplus refs roll into
          // the NEXT billing period. We re-pin each surplus referred member's refCreditDate
          // into [newBilling-1mo, newBilling) so getReferralsInBillingPeriod counts them
          // again next cycle — i.e. 4 refs → free this month AND next. Chains automatically.
          let rolled = 0;
          const { surplus } = pickSurplusReferrals(refList, 2);
          if (surplus.length > 0) {
            const creditDate = surplusCreditDate(newBillingDate);
            for (const ref of surplus) {
              try {
                await store.update(ref.phone, { refCreditDate: creditDate });
                rolled++;
              } catch (e) {
                log.warn(`⚠️  Rollover re-pin failed for ${ref.phone}: ${e.message}`);
              }
            }
            log.info(`🔁 Rolled ${rolled} surplus ref(s) for ${m.name} into next period (${creditDate})`);
          }

          autoRenewed.push({ name: m.name, phone: m.phone, refs, rolled });
          state.sentPhones.push(m.phone);
          saveState(botDir, state);
          log.info(`🎁 Auto-renewed ${m.name} (${m.phone}) — ${refs} refs${rolled ? `, ${rolled} rolled over` : ''}`);
        } catch (err) {
          failed++;
          log.warn(`❌ Auto-renew failed [${m.name}]: ${err.message}`);
        }
      } else {
        const type = refs === 1 ? 'referral' : 'normal';
        if (await sendToMember(getSock, m.phone, m.name, botDir, type)) {
          if (refs === 1) referralSent++; else sent++;
          state.sentPhones.push(m.phone);
          saveState(botDir, state);
        } else {
          failed++;
        }
      }

      if (i < members.length - 1) {
        const gap = randomBetween(config.rateLimits.memberToMemberGapMinMs, config.rateLimits.memberToMemberGapMaxMs);
        log.info(`⏳ Next reminder in ${(gap / 1000).toFixed(1)}s`);
        await sleep(gap);
      }
    }
    log.info(`⏰ ${label} done: ${sent} normal, ${referralSent} referral, ${autoRenewed.length} auto-renewed, ${failed} failed`);
    return { sent, referralSent, autoRenewed, failed };
  }

  // Members who are due today AND have not been renewed/paid today. Refreshes the store
  // first so a member just renewed via the `renewed` command (or edited directly on the
  // sheet) is never targeted — this is the core guard against the double-reminder bug.
  async function getDueToday(store) {
    await store.refresh();
    const today = todayStr();
    return store.getActive().filter(m =>
      daysFromToday(m.billingDate) === 0 && !renewedOn(m, today)
    );
  }

  // Batch 1 (6:30 AM cron) — sends up to batchSize members, skips already-sent
  async function sendReminders(store, getSock, botDir) {
    if (_busy) {
      log.warn('⏰ Reminder batch 1 skipped — another reminder run is in progress');
      return { ...NOOP_RESULT };
    }
    _busy = true;
    try {
      const state = loadState(botDir);
      const dueToday = await getDueToday(store);

      if (dueToday.length === 0) {
        log.info('⏰ Reminder batch 1: no members due today');
        return { ...NOOP_RESULT };
      }

      const pending = dueToday.filter(m => !state.sentPhones.includes(m.phone));
      if (pending.length === 0) {
        log.info('⏰ Reminder batch 1: all members already sent today');
        return { ...NOOP_RESULT };
      }

      const batch = pending.slice(0, config.rateLimits.batchSize);
      const remainder = pending.slice(config.rateLimits.batchSize);

      log.info(`⏰ Reminder batch 1: ${batch.length} members (${state.sentPhones.length} already sent, ${remainder.length} held for batch 2)`);

      const result = await runBatch(batch, getSock, botDir, state, 'Reminder batch 1', store);
      if (remainder.length > 0) {
        log.info(`📋 ${remainder.length} members held for batch 2 at 7:30 AM`);
      }
      return { ...result, queued: remainder.length };
    } finally {
      _busy = false;
    }
  }

  // Batch 2 (7:30 AM cron) — sends remaining members not yet sent today
  async function sendRemindersSecondBatch(store, getSock, botDir) {
    if (_busy) {
      log.warn('⏰ Reminder batch 2 skipped — another reminder run is in progress');
      return { ...NOOP_RESULT };
    }
    _busy = true;
    try {
      const state = loadState(botDir);
      const dueToday = await getDueToday(store);
      const remaining = dueToday.filter(m => !state.sentPhones.includes(m.phone));

      if (remaining.length === 0) {
        log.info('⏰ Reminder batch 2: nothing remaining');
        return { ...NOOP_RESULT };
      }

      log.info(`⏰ Reminder batch 2: ${remaining.length} members`);
      return await runBatch(remaining, getSock, botDir, state, 'Reminder batch 2', store);
    } finally {
      _busy = false;
    }
  }

  // Restart catch-up — sends today's due-today reminders that were never delivered because the
  // bot was offline/restarting across one or both cron windows (6:30 / 7:30). node-cron does not
  // re-fire a window the process missed, so without this a restart at 6:31 silently skips the
  // whole day's reminders. Mirrors removalEngine: persistent state + dedupe means a member is
  // never messaged twice — sentPhones (today's reminder-state.json) is the single source of truth.
  async function catchUp(store, getSock, botDir, broadcast) {
    if (_busy) {
      log.warn('⏰ Reminder catch-up skipped — another reminder run is in progress');
      return { ...NOOP_RESULT };
    }
    // Before today's first reminder window has elapsed, do nothing — let the normal cron fire it
    // on schedule. (Stops an early-morning reconnect from sending reminders before 6:30.)
    if (!cronTimePassedToday(config.schedule?.reminderSend)) {
      log.info('⏰ Reminder catch-up: before today\'s reminder window — nothing to do');
      return { ...NOOP_RESULT };
    }
    // Past the morning cutoff (default noon), do NOT replay missed reminders — too late in the
    // day to message members. Whatever was missed stays unsent until tomorrow's scheduled run.
    const cutoff = config.catchUpCutoffHour ?? 12;
    if (!beforeCatchUpCutoff(cutoff)) {
      log.info(`⏰ Reminder catch-up: past the ${cutoff}:00 cutoff — not replaying missed reminders this late`);
      return { ...NOOP_RESULT };
    }
    _busy = true;
    try {
      const state = loadState(botDir);
      const dueToday = await getDueToday(store);
      const pending = dueToday.filter(m => !state.sentPhones.includes(m.phone));

      if (pending.length === 0) {
        log.info('⏰ Reminder catch-up: nothing missed — all due-today reminders already sent');
        return { ...NOOP_RESULT };
      }

      log.info(`⏰ Reminder catch-up: ${pending.length} missed reminder(s) after restart (${state.sentPhones.length} already sent today)`);
      const result = await runBatch(pending, getSock, botDir, state, 'Reminder catch-up', store);

      if (broadcast && result.autoRenewed?.length > 0) {
        const lines = result.autoRenewed.map(m => `  • ${m.name}  ${m.phone}${m.rolled ? ` (+${m.rolled} ref rolled to next month)` : ''}`).join('\n');
        try { await broadcast(`🎁 Auto-renewed (2 refs) — catch-up after restart:\n${lines}`); } catch (_) {}
      }
      return result;
    } finally {
      _busy = false;
    }
  }

  // Called on every connection.open (see index.js). Schedules the catch-up after a short grace
  // so we don't fire on a socket that's about to drop again; re-arming clears any prior timer so
  // repeated reconnects don't stack catch-up runs.
  function resume(store, getSock, botDir, broadcast) {
    if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
    _resumeTimer = setTimeout(() => {
      _resumeTimer = null;
      catchUp(store, getSock, botDir, broadcast)
        .catch(err => log.warn(`⏰ Reminder catch-up failed: ${err.message}`));
    }, RESUME_GRACE_MS);
    log.info('⏰ Reminder catch-up scheduled (2-min grace after reconnect)');
  }

  return { sendReminders, sendRemindersSecondBatch, sendToMember, markReminded: markPhoneReminded, catchUp, resume };
}
