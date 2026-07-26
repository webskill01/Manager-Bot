import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, todayStr, parseDate, formatDate, formatDateTime, getReferralsInBillingPeriod, friendlyDate, clampedBillingDate, renewedOn, pickSurplusReferrals, surplusCreditDate, cronTimePassedToday, beforeCatchUpCutoff, isDelayActive } from './globalConfig.js';

// ── Group digest builder (pure, exported for tests) ──────────────────────────
// members: [{ name, phone, note? }] — note is an optional annotation appended to the line.
// participants: Baileys group participants [{ id, phoneNumber? }]. LID-era groups report
// p.id as @lid with the phone on p.phoneNumber — map by phone, tag with p.id (same
// pattern as ghostRemovalEngine). Members not found in the group get a plain,
// untagged "Name (phone)" line.
export function buildGroupDigest({ header, members, participants }) {
  const byPhone = new Map();
  for (const p of participants || []) {
    const src = p.phoneNumber || (String(p.id || '').endsWith('@s.whatsapp.net') ? p.id : null);
    if (src) byPhone.set(normalizePhone(src), p.id);
  }
  const lines = [];
  const mentions = [];
  for (const m of members) {
    const jid = byPhone.get(normalizePhone(m.phone));
    const note = m.note ? ` ${m.note}` : '';
    if (jid) {
      lines.push(`@${String(jid).split('@')[0]}${note}`);
      mentions.push(jid);
    } else {
      lines.push(`${m.name} (${m.phone})${note}`);
    }
  }
  return { text: `${header}\n\n${lines.join('\n')}`, mentions };
}

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

  // Silent 2-ref auto-renew: advances billing +1 month, paidLast 0, rolls surplus refs
  // into the next period. Shared by the DM batch path and the group-digest path.
  // Returns the autoRenewed entry, records the phone in day-state. Throws on store failure.
  async function autoRenewMember(m, refList, store, botDir, state) {
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

    state.sentPhones.push(m.phone);
    saveState(botDir, state);
    log.info(`🎁 Auto-renewed ${m.name} (${m.phone}) — ${refList.length} refs${rolled ? `, ${rolled} rolled over` : ''}`);
    return { name: m.name, phone: m.phone, refs: refList.length, rolled };
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
          autoRenewed.push(await autoRenewMember(m, refList, store, botDir, state));
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
        // Removal-engine-style spacing when dmReminderGap* is configured (multi-minute,
        // uneven); bots without it (bot-nitin) keep the original memberToMemberGap pacing.
        const gap = randomBetween(
          config.rateLimits.dmReminderGapMinMs ?? config.rateLimits.memberToMemberGapMinMs,
          config.rateLimits.dmReminderGapMaxMs ?? config.rateLimits.memberToMemberGapMaxMs
        );
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

  // ── Group-digest mode ───────────────────────────────────────────────────────
  // reminder.mode "group" replaces per-member DMs with (1) one QR+caption group
  // message tagging due-today members and (2) a separate overdue-tags message a few
  // minutes later. Returns null (→ DM mode) when unconfigured or groupId missing.
  function groupCfg() {
    const r = config.reminder;
    if (!r || r.mode !== 'group') return null;
    if (!r.groupId) {
      log.error('❌ reminder.mode is "group" but reminder.groupId is empty — falling back to DM mode');
      return null;
    }
    return r;
  }

  // Digest inputs: due-today (2-ref members auto-renewed silently, excluded from the due
  // tags, and recorded in state.autoRenewedToday for the celebration message) and
  // 5+ days overdue (same milestone base as the overdue engine's day-5 reminder).
  // applyAutoRenew=false (preview) leaves the sheet untouched.
  async function computeDigestSets(store, botDir, state, { applyAutoRenew }) {
    const dueRaw = await getDueToday(store);
    const all = store.getAll();
    const due = [];
    const autoRenewed = [];
    for (const m of dueRaw) {
      const refList = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
      if (refList.length >= 2) {
        if (applyAutoRenew) {
          try {
            autoRenewed.push(await autoRenewMember(m, refList, store, botDir, state));
            // Remember today's free-renewal members so the celebration message (msg 3)
            // can tag them — including on a later remindall, when they're no longer "due".
            state.autoRenewedToday = state.autoRenewedToday || [];
            if (!state.autoRenewedToday.some(a => a.phone === m.phone)) {
              state.autoRenewedToday.push({ name: m.name, phone: m.phone });
              saveState(botDir, state);
            }
          } catch (err) { log.warn(`❌ Auto-renew failed [${m.name}]: ${err.message}`); }
        }
        continue; // free renewal — never tagged as due
      }
      due.push({ name: m.name, phone: m.phone, note: '' });
    }
    const overdueDays = config.overdue?.autoReminderDays ?? 5;
    const today = todayStr();
    const overdue = store.getActive()
      .filter(m => {
        const d = daysFromToday(m.billingDate);
        return d !== null && d <= -overdueDays && !isDelayActive(m) && !renewedOn(m, today);
      })
      .map(m => ({ name: m.name, phone: m.phone, note: `— ${Math.abs(daysFromToday(m.billingDate))} din overdue` }));
    return { due, overdue, autoRenewed };
  }

  function digestHeaders() {
    return {
      h1: (config.messages.groupReminder    || '📅 Renewal reminder — {date}').replace('{date}', friendlyDate()),
      h2: (config.messages.groupOverdue     || '🚨 Overdue — {date}').replace('{date}', friendlyDate()),
      h3: (config.messages.groupAutoRenewed || '🎁 These members added 2 people — their month is FREE:').replace('{date}', friendlyDate()),
    };
  }

  // Random pause between the group digest messages so they never land as one burst.
  function interMessageGapMs() {
    return randomBetween(
      config.reminder?.msgGapMinMs ?? 4 * 60000,
      config.reminder?.msgGapMaxMs ?? 6 * 60000
    );
  }

  // Cron runs skip parts already sent today (digestSent / overdueDigestSent in
  // reminder-state.json — a restart between msg 1 and msg 2 resumes with msg 2 only).
  // remindall passes manual=true to re-fire both regardless.
  async function sendGroupDigest(store, getSock, botDir, { manual = false } = {}) {
    if (_busy) {
      log.warn('⏰ Group digest skipped — another reminder run is in progress');
      return { ...NOOP_RESULT };
    }
    _busy = true;
    try {
      const g = groupCfg();
      const state = loadState(botDir);
      const needMsg1 = manual || !state.digestSent;
      const needMsg2 = manual || !state.overdueDigestSent;
      // Celebration message is automatic-only, once per day — remindall never re-fires it.
      const needMsg3 = !manual && !state.renewFreeDigestSent;
      if (!needMsg1 && !needMsg2 && !needMsg3) {
        log.info('⏰ Group digest: all messages already sent today');
        return { ...NOOP_RESULT };
      }

      const { due, overdue, autoRenewed } = await computeDigestSets(store, botDir, state, { applyAutoRenew: true });

      let sock = getSock();
      if (!sock?.user) {
        log.warn('⚠️  Socket not ready — group digest skipped');
        return { ...NOOP_RESULT, autoRenewed };
      }

      let participants = [];
      try {
        const meta = await sock.groupMetadata(g.groupId);
        participants = meta?.participants || [];
      } catch (err) {
        log.warn(`⚠️  groupMetadata failed for digest: ${err.message} — sending without tags`);
      }

      const { h1, h2, h3 } = digestHeaders();
      let sent = 0;
      let sentAnything = false;   // gates the pause before follow-up messages

      // Msg 1 — QR image + caption, due-today tags
      if (needMsg1) {
        if (due.length === 0) {
          log.info('⏰ Group digest: no members due today — msg 1 skipped');
          state.digestSent = true;   // nothing to send counts as done for today
          saveState(botDir, state);
        } else {
          const { text, mentions } = buildGroupDigest({ header: h1, members: due, participants });
          const qrPath = config.upiQrPath ? path.resolve(botDir, config.upiQrPath) : null;
          try {
            if (qrPath && fs.existsSync(qrPath)) {
              await sock.sendMessage(g.groupId, { image: fs.readFileSync(qrPath), caption: text, mentions });
            } else {
              await sock.sendMessage(g.groupId, { text, mentions });
            }
            sent = due.length;
            sentAnything = true;
            state.digestSent = true;
            for (const m of due) if (!state.sentPhones.includes(m.phone)) state.sentPhones.push(m.phone);
            saveState(botDir, state);
            log.info(`📨 Group digest msg 1 sent — ${due.length} due member(s) tagged`);
          } catch (err) {
            log.error(`❌ Group digest msg 1 failed: ${err.message}`);
            return { ...NOOP_RESULT, autoRenewed, failed: due.length };
          }
        }
      }

      // Msg 2 — separate overdue-tags message, a few minutes later so it never
      // reads as one machine burst
      if (needMsg2) {
        if (overdue.length === 0) {
          log.info('⏰ Group digest: no 5+ day overdue members — msg 2 skipped');
          state.overdueDigestSent = true;
          saveState(botDir, state);
        } else {
          if (sentAnything) {
            const gapMs = interMessageGapMs();
            log.info(`⏳ Overdue group message in ${(gapMs / 60000).toFixed(1)} min`);
            await sleep(gapMs);
          }
          sock = getSock();
          if (!sock?.user) {
            log.warn('⚠️  Socket dropped before overdue message — batch 2 / catch-up will retry');
            return { sent, referralSent: 0, autoRenewed, failed: 0, queued: overdue.length };
          }
          const { text, mentions } = buildGroupDigest({ header: h2, members: overdue, participants });
          try {
            await sock.sendMessage(g.groupId, { text, mentions });
            sentAnything = true;
            state.overdueDigestSent = true;
            saveState(botDir, state);
            log.info(`📨 Group digest msg 2 sent — ${overdue.length} overdue member(s) tagged`);
          } catch (err) {
            log.error(`❌ Group digest msg 2 failed: ${err.message}`);
          }
        }
      }

      // Msg 3 — referral celebration: tag today's 2-ref members whose month came free.
      // Public, so it advertises the referral programme to the whole group.
      if (needMsg3) {
        const freeMembers = (state.autoRenewedToday || []).map(a => ({ name: a.name, phone: a.phone, note: '' }));
        if (freeMembers.length === 0) {
          log.info('⏰ Group digest: no 2-ref auto-renewals today — msg 3 skipped');
          state.renewFreeDigestSent = true;
          saveState(botDir, state);
        } else {
          if (sentAnything) {
            const gapMs = interMessageGapMs();
            log.info(`⏳ Referral celebration message in ${(gapMs / 60000).toFixed(1)} min`);
            await sleep(gapMs);
          }
          sock = getSock();
          if (!sock?.user) {
            log.warn('⚠️  Socket dropped before celebration message — batch 2 / catch-up will retry');
            return { sent, referralSent: 0, autoRenewed, failed: 0, queued: 0 };
          }
          const { text, mentions } = buildGroupDigest({ header: h3, members: freeMembers, participants });
          try {
            await sock.sendMessage(g.groupId, { text, mentions });
            state.renewFreeDigestSent = true;
            saveState(botDir, state);
            log.info(`📨 Group digest msg 3 sent — ${freeMembers.length} free-renewal member(s) celebrated`);
          } catch (err) {
            log.error(`❌ Group digest msg 3 failed: ${err.message}`);
          }
        }
      }

      return { sent, referralSent: 0, autoRenewed, failed: 0, queued: 0 };
    } finally {
      _busy = false;
    }
  }

  // Manual `remindall` command — re-fires the digest (msg 1 now, msg 2 ~5 min later),
  // running in the background so the command reply is instant. The day-6 final DM is
  // never part of this (it goes once per day via the overdue engine only).
  async function remindAll(store, getSock, botDir, { preview = false } = {}) {
    if (!groupCfg()) {
      return '❌ remindall works in group reminder mode only — set reminder.mode to "group" and fill reminder.groupId in this bot\'s config.';
    }

    if (preview) {
      const state = loadState(botDir);
      const { due, overdue } = await computeDigestSets(store, botDir, state, { applyAutoRenew: false });
      const { h1, h2 } = digestHeaders();
      const m1 = due.length     ? buildGroupDigest({ header: h1, members: due,     participants: [] }).text : '(no members due today — msg 1 skipped)';
      const m2 = overdue.length ? buildGroupDigest({ header: h2, members: overdue, participants: [] }).text : '(no 5+ day overdue members — msg 2 skipped)';
      return `🔎 PREVIEW — names shown; the real send tags members\n(celebration msg is automatic-only, not part of remindall)\n\n━━ Message 1 (QR + caption) ━━\n${m1}\n\n━━ Message 2 (~5 min later) ━━\n${m2}`;
    }

    if (_busy) return '⏳ A reminder run is already in progress — try again in a few minutes.';
    sendGroupDigest(store, getSock, botDir, { manual: true })
      .then(r => log.info(`🔔 remindall done — ${r.sent} due tagged`))
      .catch(err => log.error(`❌ remindall failed: ${err.message}`));
    return '🔔 Group reminder firing — due-today message now, overdue message in ~5 min.';
  }

  // Batch 1 (6:30 AM cron) — sends up to batchSize members, skips already-sent
  async function sendReminders(store, getSock, botDir) {
    if (groupCfg()) return sendGroupDigest(store, getSock, botDir);
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

  // Batch 2 (7:30 AM cron) — sends remaining members not yet sent today.
  // Group mode: acts as a retry — sendGroupDigest only sends parts still unsent.
  async function sendRemindersSecondBatch(store, getSock, botDir) {
    if (groupCfg()) return sendGroupDigest(store, getSock, botDir);
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
    // Group mode: resend whichever digest part never went out (idempotent via
    // digestSent/overdueDigestSent flags — same restart-safety as sentPhones).
    if (groupCfg()) return sendGroupDigest(store, getSock, botDir);
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

      // Logged, not broadcast — see the note in index.js. Auto-renewals show up in the
      // `digest` command; no admin gets an unprompted DM about them.
      if (result.autoRenewed?.length > 0) {
        log.info(`🎁 Auto-renewed (2 refs), restart catch-up: ${result.autoRenewed.map(m => `${m.name} ${m.phone}${m.rolled ? ` +${m.rolled} rolled` : ''}`).join(', ')}`);
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

  return { sendReminders, sendRemindersSecondBatch, sendToMember, markReminded: markPhoneReminded, catchUp, resume, remindAll };
}
