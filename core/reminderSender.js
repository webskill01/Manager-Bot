import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, todayStr, parseDate, formatDate, formatDateTime, getReferralsInBillingPeriod, friendlyDate, clampedBillingDate, renewedOn, pickSurplusReferrals, surplusCreditDate, cronTimePassedToday, beforeCatchUpCutoff, isDelayActive, pickVariant, resolveWhatsAppJid } from './globalConfig.js';
import { usesCloudApi, createCloudApiSender } from './cloudApiSender.js';

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

// Hard cap on @mentions in one group message. A digest normally tags a handful, but
// ~650 members means ~22 due on a busy day, and after an outage the overdue list can run
// into the hundreds. One message tagging 100+ people is unreadable for members and a
// textbook bulk-mention spam signal. At or below the cap the behaviour is unchanged —
// exactly one message, same as before.
export const MAX_TAGS_PER_MSG = 20;

export function chunkMembers(members, max = MAX_TAGS_PER_MSG) {
  if (members.length <= max) return [members];
  // Balanced, not greedy: 23 members become 12 + 11, never 20 + 3. Same number of
  // messages either way, but a 3-person message on its own reads like an afterthought.
  const parts = Math.ceil(members.length / max);
  const base = Math.floor(members.length / parts);
  const extra = members.length % parts;   // the first `extra` chunks carry one more
  const out = [];
  let i = 0;
  for (let p = 0; p < parts; p++) {
    const size = base + (p < extra ? 1 : 0);
    out.push(members.slice(i, i + size));
    i += size;
  }
  return out;
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
  return { date: todayStr(), sentPhones: [], sends: [], failures: [] };
}

function saveState(botDir, state) {
  const stateFile = path.join(botDir, 'reminder-state.json');
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, stateFile);
}

// ── The send log ──────────────────────────────────────────────────────────────
// Once reminders leave over the Cloud API, nothing arrives on the operator's own phone —
// so the API's own answer is the only evidence a reminder was sent, and it has to be kept
// somewhere better than pm2 logs. These two ride along in the existing day-state file:
// no new store, no rotation to lose, atomically written per member.
//
// `sends` holds Meta's wamid, which is what a Phase-5 delivery webhook will match on.
// A day-scoped record is enough — the per-batch Telegram report is the durable history.
function recordSend(state, member, type, messageId) {
  (state.sends ??= []).push({
    phone: member.phone, name: member.name, type,
    messageId: messageId || null, at: new Date().toISOString(),
  });
}

function recordFailure(state, member, res) {
  (state.failures ??= []).push({
    phone: member.phone, name: member.name,
    error: res?.error || 'unknown', code: res?.code ?? null,
    at: new Date().toISOString(),
  });
}

// Rendered by the `sent` command and by the per-batch report. Meta's error code is included
// verbatim because it is the difference between "one bad number" (131026) and "your token
// died" (190) — and the operator can only act on the second.
export function renderSendLog(botDir) {
  const state = loadState(botDir);
  const sends = state.sends || [];
  const failures = state.failures || [];
  if (sends.length === 0 && failures.length === 0) {
    return `📭 No reminders sent yet today (${state.date}).\n\n` +
      `If you expected some, check: due — and whether the 6:30 AM batch ran (pm2 logs).`;
  }
  const lines = [`📨 *Reminders today* (${state.date}) — ${sends.length} sent, ${failures.length} failed`, ''];
  for (const s of sends) {
    const id = s.messageId ? `  ${s.messageId}` : '';
    lines.push(`✅ ${s.name} ${s.phone}${s.type === 'referral' ? ' (ref ₹45)' : ''}${id}`);
  }
  if (failures.length > 0) {
    lines.push('', 'Failed:');
    for (const f of failures) {
      lines.push(`❌ ${f.name} ${f.phone} — ${f.error}${f.code ? ` [${f.code}]` : ''}`);
    }
    lines.push('', 'Send these by hand: dmlist');
  }
  return lines.join('\n');
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

// fetchImpl is for tests only: it lets the Cloud API path be asserted without reaching for
// globalThis.fetch, so a suite can prove a reminder never touches the WhatsApp socket.
export function createReminderSender(config, log, { fetchImpl } = {}) {
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

  // A run of failures trips the breaker whichever channel produced them: ten straight
  // Cloud API rejections mean an expired token or an unfunded balance, and hammering Meta
  // with 20 more is no better than hammering WhatsApp.
  function noteSuccess() { consecutiveFailures = 0; }
  function noteFailure(what, reason) {
    consecutiveFailures++;
    log.warn(`❌ Reminder failed [${what}]: ${reason}`);
    if (consecutiveFailures >= config.rateLimits.circuitBreakerThreshold) {
      circuitOpen = true;
      circuitOpenAt = Date.now();
      log.error(`⚡ Circuit breaker OPEN — ${consecutiveFailures} consecutive failures`);
    }
  }

  let _cloudSender = null;
  const cloudSender = () => (_cloudSender ??= createCloudApiSender(config, log, fetchImpl ? { fetchImpl } : {}));

  // billingDate is the member's own — {date} must render THEIR renewal date, not today's.
  // Defaults to '' so friendlyDate falls back to today for any caller that lacks it.
  //
  // Returns { ok, messageId?, error? }. The message id is Meta's wamid, and it is the ONLY
  // evidence a reminder left: nothing arrives on the operator's own phone any more, so the
  // caller records it (see runBatch → state.sends) and reports it to Telegram.
  async function sendToMember(getSock, phone, name, botDir, type = 'normal', billingDate = '') {
    if (checkCircuit()) {
      log.warn(`⚡ Circuit open — skipping ${name}`);
      return { ok: false, error: 'circuit breaker open' };
    }

    const date = friendlyDate(billingDate);

    // Official Cloud API. Deliberately never calls getSock(): proactive payment-demand DMs
    // over Baileys are the single strongest ban signal there is, and Meta's own API cannot
    // get a number banned for sending them. It also means reminders survive a 403 — the
    // socket being dead is irrelevant on this path.
    if (usesCloudApi(config)) {
      const res = await cloudSender().sendTemplate({
        phone,
        type: type === 'referral' ? 'referralReminder' : 'reminder',
        bodyParams: [name, date],
      });
      if (res.ok) {
        noteSuccess();
        return { ok: true, messageId: res.messageId };
      }
      noteFailure(name, res.error);
      return { ok: false, error: res.error, code: res.code };
    }

    const sock = getSock();
    if (!sock?.user) {
      log.warn(`⚠️  Socket not ready — skipping ${name}`);
      return { ok: false, error: 'WhatsApp socket not ready' };
    }

    // Same addressing fix as the drip's autoSend, and for the same reason: a phone JID we
    // assembled ourselves is a guess, and a LID-primary account accepts it silently without
    // ever showing the message. Fails OPEN — only an explicit "does not exist" stops a send.
    let jid = `91${normalizePhone(phone)}@s.whatsapp.net`;
    try {
      const found = await resolveWhatsAppJid(sock, phone);
      if (!found.exists) {
        log.warn(`📵 ${name} (${phone}) is not on WhatsApp — reminder not sent`);
        return { ok: false, error: 'not on WhatsApp', unreachable: true };
      }
      jid = found.jid;
    } catch (err) {
      log.warn(`⚠️  JID lookup failed for ${phone} — sending to the phone JID: ${err.message}`);
    }
    // pickVariant, not the raw config value: every bot's messages.reminder is an ARRAY of
    // wordings, and calling .replace on an array throws. Only the drip's tap-to-send path
    // rotated them, so this — the socket auto-send path — was one send away from a
    // TypeError the moment a bot ran reminders itself instead of by hand.
    const template = pickVariant(type === 'referral' && config.messages.referralReminder
      ? config.messages.referralReminder
      : config.messages.reminder, phone);
    const caption = template.replace('{name}', name).replace('{date}', date);

    try {
      // pickVariant, not the raw value: upiQrPath is a LIST on any bot running QR variants,
      // and path.resolve(dir, []) throws TypeError before the reminder ever goes out. Keyed
      // on phone, so a member always gets the same image as the drip would send them.
      const qrFile = config.upiQrPath ? pickVariant(config.upiQrPath, phone) : null;
      const qrPath = qrFile ? path.resolve(botDir, qrFile) : null;
      if (qrPath && fs.existsSync(qrPath)) {
        const image = fs.readFileSync(qrPath);
        await sock.sendMessage(jid, { image, caption });
      } else {
        await sock.sendMessage(jid, { text: caption });
      }
      log.info(`📨 Reminder sent (${type}): ${name} (${phone})`);
      noteSuccess();
      return { ok: true };
    } catch (err) {
      noteFailure(name, err.message);
      return { ok: false, error: err.message };
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
        const res = await sendToMember(getSock, m.phone, m.name, botDir, type, m.billingDate);
        if (res.ok) {
          if (refs === 1) referralSent++; else sent++;
          state.sentPhones.push(m.phone);
          recordSend(state, m, type, res.messageId);
        } else {
          failed++;
          recordFailure(state, m, res);
        }
        // Persisted per member, not per batch: a crash halfway through must leave an
        // accurate record of who was already messaged, or the retry double-charges and
        // double-messages them.
        saveState(botDir, state);
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
    // The official Cloud API outranks group mode, and every caller of groupCfg() inherits
    // that from here rather than each checking for itself.
    //
    // Group mode exists only because proactive DMs over Baileys got numbers banned: tagging
    // people in a group was the least-bad way to nag them. The Cloud API removes the reason
    // — it cannot get the number banned — so a private reminder is once again both better
    // for the member and safer for us. It is also the last proactive Baileys traffic left,
    // which is exactly what we are trying to stop emitting.
    if (usesCloudApi(config)) return null;
    if (!r.groupId) {
      log.error('❌ reminder.mode is "group" but reminder.groupId is empty — falling back to DM mode');
      return null;
    }
    return r;
  }

  // Apply the 2-referral free renewal to everyone due today, and return who was renewed.
  // Split out of computeDigestSets so the manual `dmlist` path gets the same silent
  // auto-renew the cron used to do — otherwise a member who owes nothing would be
  // chased for money. Returns [] and touches nothing when nobody qualifies.
  async function autoRenewDue(store, botDir) {
    const state = loadState(botDir);
    const dueRaw = await getDueToday(store);
    const all = store.getAll();
    const renewed = [];
    for (const m of dueRaw) {
      const refList = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
      if (refList.length < 2) continue;
      try {
        renewed.push(await autoRenewMember(m, refList, store, botDir, state));
      } catch (err) {
        log.warn(`❌ Auto-renew failed [${m.name}]: ${err.message}`);
      }
    }
    return renewed;
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
          // upiQrPath may be a LIST — resolve() on an array throws. One image per group per
          // day, picked off the group id so two groups do not get byte-identical media.
          const qrFile = config.upiQrPath ? pickVariant(config.upiQrPath, g.groupId) : null;
          const qrPath = qrFile ? path.resolve(botDir, qrFile) : null;
          const chunks = chunkMembers(due);
          try {
            for (let ci = 0; ci < chunks.length; ci++) {
              if (ci > 0) await sleep(interMessageGapMs());
              const { text, mentions } = buildGroupDigest({ header: h1, members: chunks[ci], participants });
              const live = getSock();
              if (!live?.user) throw new Error('socket dropped mid-digest');
              if (qrPath && fs.existsSync(qrPath)) {
                await live.sendMessage(g.groupId, { image: fs.readFileSync(qrPath), caption: text, mentions });
              } else {
                await live.sendMessage(g.groupId, { text, mentions });
              }
              if (chunks.length > 1) log.info(`📨 Group digest msg 1 part ${ci + 1}/${chunks.length} — ${chunks[ci].length} tagged`);
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
          const chunks2 = chunkMembers(overdue);
          try {
            for (let ci = 0; ci < chunks2.length; ci++) {
              if (ci > 0) await sleep(interMessageGapMs());
              const { text, mentions } = buildGroupDigest({ header: h2, members: chunks2[ci], participants });
              const live = getSock();
              if (!live?.user) throw new Error('socket dropped mid-digest');
              await live.sendMessage(g.groupId, { text, mentions });
              if (chunks2.length > 1) log.info(`📨 Group digest msg 2 part ${ci + 1}/${chunks2.length} — ${chunks2[ci].length} tagged`);
            }
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
          const chunks3 = chunkMembers(freeMembers);
          try {
            for (let ci = 0; ci < chunks3.length; ci++) {
              if (ci > 0) await sleep(interMessageGapMs());
              const { text, mentions } = buildGroupDigest({ header: h3, members: chunks3[ci], participants });
              const live = getSock();
              if (!live?.user) throw new Error('socket dropped mid-digest');
              await live.sendMessage(g.groupId, { text, mentions });
              if (chunks3.length > 1) log.info(`📨 Group digest msg 3 part ${ci + 1}/${chunks3.length} — ${chunks3[ci].length} tagged`);
            }
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

  return { sendReminders, sendRemindersSecondBatch, sendToMember, markReminded: markPhoneReminded, catchUp, resume, remindAll, autoRenewDue };
}
