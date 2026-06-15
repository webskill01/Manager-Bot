import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, todayStr, parseDate, formatDate, formatDateTime, getReferralsInBillingPeriod, friendlyDate, clampedBillingDate, renewedOn, pickSurplusReferrals, surplusCreditDate } from './globalConfig.js';

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
    const state = loadState(botDir);
    const dueToday = await getDueToday(store);

    if (dueToday.length === 0) {
      log.info('⏰ Reminder batch 1: no members due today');
      return { sent: 0, referralSent: 0, autoRenewed: [], failed: 0, queued: 0 };
    }

    const pending = dueToday.filter(m => !state.sentPhones.includes(m.phone));
    if (pending.length === 0) {
      log.info('⏰ Reminder batch 1: all members already sent today');
      return { sent: 0, referralSent: 0, autoRenewed: [], failed: 0, queued: 0 };
    }

    const batch = pending.slice(0, config.rateLimits.batchSize);
    const remainder = pending.slice(config.rateLimits.batchSize);

    log.info(`⏰ Reminder batch 1: ${batch.length} members (${state.sentPhones.length} already sent, ${remainder.length} held for batch 2)`);

    const result = await runBatch(batch, getSock, botDir, state, 'Reminder batch 1', store);
    if (remainder.length > 0) {
      log.info(`📋 ${remainder.length} members held for batch 2 at 7:30 AM`);
    }
    return { ...result, queued: remainder.length };
  }

  // Batch 2 (7:30 AM cron) — sends remaining members not yet sent today
  async function sendRemindersSecondBatch(store, getSock, botDir) {
    const state = loadState(botDir);
    const dueToday = await getDueToday(store);
    const remaining = dueToday.filter(m => !state.sentPhones.includes(m.phone));

    if (remaining.length === 0) {
      log.info('⏰ Reminder batch 2: nothing remaining');
      return { sent: 0, referralSent: 0, autoRenewed: [], failed: 0 };
    }

    log.info(`⏰ Reminder batch 2: ${remaining.length} members`);
    return runBatch(remaining, getSock, botDir, state, 'Reminder batch 2', store);
  }

  return { sendReminders, sendRemindersSecondBatch, sendToMember, markReminded: markPhoneReminded };
}
