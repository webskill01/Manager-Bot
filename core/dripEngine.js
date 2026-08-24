import fs from 'fs';
import path from 'path';
import { randomBetween, todayStr, friendlyDate, sleep, normalizePhone, pickVariant } from './globalConfig.js';
import { buildDmList } from './dmList.js';
import { usesCloudApi } from './cloudApiSender.js';

// Paces one day's renewal reminders, in one of two delivery modes.
//
//   manual (the default, and what the three friend bots still run)
//     The bot holds no socket and sends nothing to any member. It pushes tap-to-send wa.me
//     links to Telegram on a timer; the operator taps and the message goes from their own
//     phone. It exists because the operator kept forgetting to run `dmlist` and then sent a
//     whole day's reminders in one sitting, which is the worst possible shape.
//
//   auto  ("drip": { "mode": "auto" }, bot-nitin only, from 25-08-2026)
//     The engine sends over the Baileys socket itself, one member per tick.
//
// Why auto exists, given that a linked device sending on a schedule is what caused the July
// ban: the ban that killed manual mode was NOT a pacing failure, it was a NOTIFICATION
// failure. Telegram did not deliver three pushes, the operator opened the app, saw them
// stacked, and hand-sent six WhatsApp messages back to back. Manual pacing is only as good
// as the human's ability to see the pushes arrive; a timer has no such dependency. The gaps
// below are enforced rather than suggested, which is strictly safer than what it replaced —
// and far safer than the 6 AM cron that caused the ORIGINAL ban, because that fired every
// reminder of the day inside one minute.
//
// Auto mode is available only where a socket is (core/index.js). core/telegram.js hands no
// sender in, so the three Telegram-only bots cannot enter it even if someone edits their
// config — the capability is absent, not merely disabled.

// Manual defaults, sized against a 929-member sheet: ~31 members come due each day, and a
// 9 AM-9 PM window at an 18-25 min gap gives ~34 slots. A range rather than a fixed gap plus
// jitter because a random range IS the jitter.
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 21;
const DEFAULT_GAP_MIN_MS = 18 * 60 * 1000;
const DEFAULT_GAP_MAX_MS = 25 * 60 * 1000;

// Auto defaults. 6 AM-6 PM: the same 12 hours as manual, shifted earlier, because nothing
// has to wait for the operator to be awake and holding their phone. gapMin is the FLOOR —
// a 20 min floor is "never more than 3 an hour" stated the other way round — and gapCap
// stops a five-person day from putting four hours between messages. gapMax goes unused in
// auto mode: the gap is computed from the queue, not drawn from a range.
const DEFAULT_AUTO_START_HOUR = 6;
const DEFAULT_AUTO_END_HOUR = 18;
const DEFAULT_AUTO_GAP_MIN_MS = 20 * 60 * 1000;
const DEFAULT_GAP_CAP_MS = 2 * 60 * 60 * 1000;
// The first send does not go out when the window opens. The 6 AM cron already carries the
// scheduler's ≤20 min jitter; this adds up to 40 more on top, so the day's first message
// lands somewhere in a ~60 min spread and never at a recognisable time.
const DEFAULT_FIRST_DELAY_MAX_MS = 40 * 60 * 1000;

export function dripSettings(config) {
  const d = config.drip || {};
  const auto = d.mode === 'auto';
  return {
    mode: auto ? 'auto' : 'manual',
    startHour: d.startHour ?? (auto ? DEFAULT_AUTO_START_HOUR : DEFAULT_START_HOUR),
    endHour: d.endHour ?? (auto ? DEFAULT_AUTO_END_HOUR : DEFAULT_END_HOUR),
    gapMinMs: d.gapMinMs ?? (auto ? DEFAULT_AUTO_GAP_MIN_MS : DEFAULT_GAP_MIN_MS),
    gapMaxMs: d.gapMaxMs ?? DEFAULT_GAP_MAX_MS,
    gapCapMs: d.gapCapMs ?? DEFAULT_GAP_CAP_MS,
    firstDelayMaxMs: d.firstDelayMaxMs ?? DEFAULT_FIRST_DELAY_MAX_MS,
  };
}

// How long to wait before the next auto send: the rest of the window divided by everyone
// still owed a message, so a 10-person day paces itself at ~70 min and a 35-person day
// closes up to the 20 min floor on its own. No table of rates to maintain, and no day where
// the queue empties by 9 AM and the number then transmits nothing for nine hours.
//
// Floor first, cap second, then up to +40% of wobble. The wobble only ever ADDS: a ±20%
// either way reads as the obvious choice and is wrong, because 20 minutes minus 20% is 16,
// and 16 minute gaps are 3.75 an hour — the floor is the ban control, and a jitter that can
// walk underneath it is not a floor. Adding only means the stated ceiling of 3 an hour holds
// on every single gap, and the cost is a slightly longer day.
//
// When the queue is too long for even the floor, the tail is simply not sent today. The 5/6
// ladder absorbs that by making those members one day more overdue; tightening the gap to
// fit them in is the one thing that must never happen.
export function adaptiveGapMs(remaining, msLeftInWindow, settings, rand = Math.random) {
  const even = remaining > 0 ? msLeftInWindow / remaining : settings.gapCapMs;
  const gap = Math.min(Math.max(even, settings.gapMinMs), settings.gapCapMs);
  return Math.round(gap * (1 + rand() * 0.4));
}

// One tick's worth of work: at most one member from each of the three cohorts, so the queues
// drain in parallel and the operator gets up to three links per buzz instead of three
// separate buzzes. Buzz count therefore tracks the LONGEST queue (~31/day) while links track
// the sum (~53/day).
//
// Rebuilt from the sheet on every tick rather than held in state. That is what makes a
// mid-day payment drop someone automatically, with no reconciliation step and no stale queue
// to corrupt across a restart. `seen` also spans cohorts, so a member who straddles two
// windows on a tight ladder still gets exactly one link.
export function buildDripBatch({ members, config, pushed = [], now = todayStr(), max = 3 }) {
  const seen = new Set(pushed.map(String));
  const batch = [];
  // Most-overdue cohort first. Irrelevant when all three go out together; decisive when
  // `max` is 1, as auto mode sets it. The final-notice cohort has exactly one day to be
  // reached before day 7 moves them to the removal list, whereas a due-today member missed
  // now simply becomes a nudge tomorrow. Draining 'due' first on a busy day would quietly
  // cost people their last notice.
  for (const cohort of ['final', 'nudge', 'due']) {
    if (batch.length >= max) break;
    const { rows } = buildDmList({ members, config, cohort, now });
    const row = rows.find(r => !seen.has(String(r.phone)));
    if (row) { batch.push(row); seen.add(String(row.phone)); }
  }
  return batch;
}

// Everyone still owed a link today, across all three cohorts, deduped.
export function countRemaining({ members, config, pushed = [] }) {
  const seen = new Set(pushed.map(String));
  const phones = new Set();
  for (const cohort of ['due', 'nudge', 'final']) {
    for (const r of buildDmList({ members, config, cohort }).rows) {
      if (!seen.has(String(r.phone))) phones.add(String(r.phone));
    }
  }
  return phones.size;
}

const STAGE_LABEL = { msg1: 'due today', msg2: 'overdue', msg3: 'FINAL notice' };

export function renderDripBatch(batch, remaining) {
  const lines = [`📤 *Send these now* — ${friendlyDate()}`, ''];
  for (const r of batch) {
    const age = r.overdueDays === 0 ? 'due today' : `${r.overdueDays}d overdue`;
    lines.push(`${STAGE_LABEL[r.stage]} · ${r.name} · ₹${r.fee} · ${age}`);
    lines.push(r.link);
    lines.push('');
  }
  lines.push(`(${remaining} left today)`);
  return lines.join('\n');
}

export function withinWindow(when, settings) {
  const h = when.getHours();
  return h >= settings.startHour && h < settings.endHour;
}

// `notify` is index.js's notifyTelegram, already bound to config.dripIds.
//
// `sender` is the auto-mode capability: { getSock, warmingUp }. Passed ONLY by core/index.js,
// which is the only caller that has a socket. Omit it — as core/telegram.js does — and the
// engine physically cannot send over WhatsApp, whatever the config says.
export function createDripEngine(config, log, store, reminderSender, notify, sender = null) {
  const stateFile = path.join(config.botDir, 'drip-state.json');
  // phone → the billingDate of the cycle we last sent that member a QR in. Survives restarts
  // and, unlike drip-state, is NOT reset daily: a cycle spans a week of messages.
  const qrFile = path.join(config.botDir, 'qr-sent.json');
  const settings = dripSettings(config);
  let _timer = null;

  // Config asked for auto but the caller handed no socket: stay manual and say so once. A
  // silent downgrade would leave the operator believing reminders were going out.
  const auto = settings.mode === 'auto' && !!sender?.getSock;

  // Consecutive send failures, reset by any success. Sends that fail in a row are the shape
  // trouble takes before it is announced: a number that has been restricted still accepts
  // sendMessage and simply fails to deliver, and a loop that keeps trying for eleven hours
  // turns a warning into an escalation. Five in a row ends the day and says so.
  let failStreak = 0;
  const FAIL_LIMIT = config.drip?.failLimit ?? 5;
  if (settings.mode === 'auto' && !auto) {
    log.warn('💧 Drip mode "auto" ignored — this bot has no WhatsApp socket. Running manual.');
  }
  if (auto) {
    log.info(`💧 Drip AUTO — the bot sends, ${settings.startHour}:00-${settings.endHour}:00, ` +
             `≥${Math.round(settings.gapMinMs / 60000)}m apart, gap adapts to the queue`);
  }

  // ── Are they still in the groups? ──────────────────────────────────────────
  //
  // The sheet says who SHOULD be paying; only WhatsApp knows who is still in the groups.
  // Someone who left is the single most likely person to press "report" — they are being
  // asked for ₹90 for a room they walked out of — and reports, not volume, are what get a
  // number banned. Rare, per the operator, which is exactly why it is worth catching: a
  // handful of reports is all it takes.
  //
  // One fetch a day, held in memory. groupFetchAllParticipating is a single round trip for
  // every group at once; the per-group loop is the fallback for a Baileys build without it.
  let roster = null;          // Set<phone10>, or null when unknown
  let rosterDay = null;

  async function loadRoster(sock) {
    const phones = new Set();
    let metas = null;
    try {
      if (typeof sock.groupFetchAllParticipating === 'function') {
        metas = Object.values(await sock.groupFetchAllParticipating())
          .filter(m => config.paidGroups?.includes(m.id));
      }
    } catch (err) { log.warn(`⚠️  Roster fetch failed: ${err.message}`); }

    if (!metas) {
      metas = [];
      for (const id of config.paidGroups || []) {
        try { metas.push(await sock.groupMetadata(id)); }
        catch (err) { log.warn(`⚠️  Roster: group ${id} unreadable — ${err.message}`); }
        await sleep(1200);
      }
    }

    for (const meta of metas) {
      for (const p of meta?.participants || []) {
        // LID-addressed groups report p.id as @lid, with the phone JID on p.phoneNumber.
        const jid = p.phoneNumber || p.jid || p.id || '';
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        const ph = normalizePhone(jid.replace('@s.whatsapp.net', '').replace(/\D/g, ''));
        if (ph && ph.length >= 10) phones.add(ph);
      }
    }
    return phones;
  }

  // Fail OPEN, on purpose and in three separate places: an unreadable roster, a roster that
  // resolved implausibly few phones, and any thrown error all mean "send anyway".
  //
  // The asymmetry is the whole design. Wrongly skipping a paying member costs real money and
  // is invisible — nobody complains that they were NOT asked to pay. Wrongly messaging one
  // person who left costs one possible report. In LID-era groups a chunk of participants
  // cannot be resolved to a phone number at all, so a strict gate would quietly mute most of
  // the sheet; the half-of-active floor is what catches that before it happens.
  async function stillInGroups(phone, sock) {
    const today = todayStr();
    if (rosterDay !== today) {
      rosterDay = today;
      try { roster = await loadRoster(sock); }
      catch (err) { roster = null; log.warn(`⚠️  Roster unavailable: ${err.message}`); }

      const active = store.getAll().filter(m => m.status === 'ACTIVE').length;
      if (roster && roster.size < active / 2) {
        log.warn(`⚠️  Roster resolved only ${roster.size} phones against ${active} active ` +
                 `members — too few to trust, skipping the group check today`);
        roster = null;
      } else if (roster) {
        log.info(`👥 Roster — ${roster.size} phones across ${config.paidGroups?.length || 0} groups`);
      }
    }
    return roster ? roster.has(normalizePhone(phone)) : true;
  }

  // What a real person does before a message appears: their client subscribes to the other
  // side's presence when the chat opens, then broadcasts "composing" for as long as they are
  // typing, then stops. A message that arrives with none of that in front of it is one of the
  // cheapest bot tells WhatsApp has. Roughly 40-90ms per character, floored at 2.5s and
  // capped at 12s — plausible for the message, without leaving anyone watching "typing…"
  // for a minute.
  //
  // Every presence call is best-effort: they are decoration, and a failed one must never
  // cost the reminder it was dressing up.
  // "drip": { "humanDelay": false } keeps the presence updates and drops only the waiting.
  // Exists for the test suite, which otherwise spends four real seconds per simulated send;
  // never set it on a live bot, where the pauses ARE the point.
  const pause = (ms) => (config.drip?.humanDelay === false ? Promise.resolve() : sleep(ms));

  async function sendLikeHuman(sock, jid, content, text) {
    try {
      await sock.presenceSubscribe(jid);
      await pause(randomBetween(400, 1200));
      await sock.sendPresenceUpdate('composing', jid);
      await pause(Math.min(12000, Math.max(2500, text.length * randomBetween(40, 90))));
      await sock.sendPresenceUpdate('paused', jid);
      await pause(randomBetween(300, 900));
    } catch (err) {
      log.warn(`⚠️  Presence failed for ${jid}: ${err.message}`);
    }
    await sock.sendMessage(jid, content);
  }

  // One reminder, sent by the bot. Returns false rather than throwing when the socket is not
  // there, so tick() can retry the same member shortly instead of burning their slot.
  async function autoSend(row) {
    const sock = sender.getSock?.();
    if (!sock?.user) {
      log.warn('💧 Auto-send held — WhatsApp socket not ready');
      return false;
    }
    const jid = `91${normalizePhone(row.phone)}@s.whatsapp.net`;

    // The QR rides the first message of each billing CYCLE — see needsQr. Later messages in
    // the same cycle go to someone who has it in this very chat, a scroll away, so re-sending
    // buys nothing and costs a second and third image. Media is the heaviest thing this bot
    // transmits and the easiest to fingerprint, so roughly half of them stop existing.
    //
    // upiQrPath may be a LIST. Same payee, different bytes: WhatsApp identifies media by file
    // hash, so one identical image landing on 600 phones is a far louder signal than any
    // repeated wording. pickVariant is keyed on phone, so a member always gets the same one.
    const wantsQr = needsQr(row);
    const qr = wantsQr ? pickVariant(config.upiQrPath, row.phone) : null;
    const qrPath = qr ? path.resolve(config.botDir, qr) : null;
    const withQr = !!(qrPath && fs.existsSync(qrPath));
    const content = withQr
      ? { image: fs.readFileSync(qrPath), caption: row.text }
      : { text: row.text };

    await sendLikeHuman(sock, jid, content, row.text);
    // Recorded only AFTER the send lands. A QR marked sent on a message that threw would
    // leave that member without one for the whole cycle.
    if (withQr) noteQrSent(row);
    log.info(`💧 Auto-sent ${STAGE_LABEL[row.stage]} → ${row.name} (${row.phone})${withQr ? ' +QR' : ''}`);
    return true;
  }

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (s.date === todayStr()) return s;
      }
    } catch (err) { log.warn(`⚠️  Drip state read failed: ${err.message}`); }
    return { date: todayStr(), pushed: [], stopped: false, done: false, armedAt: null };
  }

  function saveState(s) {
    try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
    catch (err) { log.error(`❌ Drip state save failed: ${err.message}`); }
  }

  function loadQrLog() {
    try { return JSON.parse(fs.readFileSync(qrFile, 'utf8')); }
    catch { return {}; }
  }

  // Has this member already been sent the QR for the cycle they are currently in?
  //
  // NOT "is this msg1", which is what this used to be and was wrong. A member missed on their
  // due date never gets msg1 at all — the 'due' cohort is exactly day 0 — so their first ever
  // contact is the day-5 nudge. Keying on msg1 meant that person was chased for ₹90 twice
  // with no way to pay. Keyed on the cycle, whichever message reaches them FIRST carries the
  // QR and the rest go without.
  //
  // Their billingDate is the cycle id: it moves forward the moment they renew, so next
  // month's first message carries a QR again with nothing to reset or expire.
  function needsQr(row) {
    return loadQrLog()[String(row.phone)] !== row.billingDate;
  }

  function noteQrSent(row) {
    try {
      const log_ = loadQrLog();
      log_[String(row.phone)] = row.billingDate;
      fs.writeFileSync(qrFile, JSON.stringify(log_, null, 2));
    } catch (err) { log.warn(`⚠️  QR log write failed: ${err.message}`); }
  }

  function clearTimer() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  // Milliseconds from now until the window closes. Negative once it has.
  function msLeftInWindow(now = new Date()) {
    const end = new Date(now);
    end.setHours(settings.endHour, 0, 0, 0);
    return end - now;
  }

  // `remaining` is how many members are still owed a message today, and is what makes auto
  // mode self-pacing. Manual mode ignores it and keeps drawing from its fixed range: the
  // operator is the rate limit there, and pushing links faster than they can tap is how the
  // stacking that caused the ban happens.
  function scheduleNext(remaining = 0) {
    clearTimer();
    const gap = auto
      ? adaptiveGapMs(remaining, msLeftInWindow(), settings)
      : randomBetween(settings.gapMinMs, settings.gapMaxMs);
    log.info(`💧 Next ${auto ? 'auto send' : 'drip push'} in ${Math.round(gap / 60000)}m` +
             (auto ? ` (${remaining} left)` : ''));
    _timer = setTimeout(() => { tick().catch(err => log.error(`❌ Drip tick: ${err.message}`)); }, gap);
    if (_timer.unref) _timer.unref();
  }

  // Socket down mid-window. Come back in a few minutes rather than waiting out a full
  // adaptive gap — a reconnect usually takes seconds, and the member has not been sent to,
  // so nothing is out of order.
  function retrySoon() {
    clearTimer();
    _timer = setTimeout(() => { tick().catch(err => log.error(`❌ Drip tick: ${err.message}`)); }, 5 * 60 * 1000);
    if (_timer.unref) _timer.unref();
  }

  async function tick() {
    if (cloudApiActive()) return;
    const state = loadState();
    if (state.stopped || state.done) return;

    if (!withinWindow(new Date(), settings)) return finish(state);

    // Auto mode transmits over WhatsApp, so unlike manual mode it is subject to warm-up: a
    // freshly linked number whose first act is a paced reminder run is exactly the profile
    // that gets a fresh link flagged. Held, not cancelled — the day resumes when the window
    // is still open and the warm-up has expired.
    if (auto && sender.warmingUp?.()) {
      log.info('🐣 Warm-up — auto send held');
      return retrySoon();
    }

    await store.refresh();
    const members = store.getAll();
    const batch = buildDripBatch({ members, config, pushed: state.pushed, max: auto ? 1 : 3 });
    if (batch.length === 0) return finish(state);

    if (auto) {
      // Gone from every group → no message, and no slot spent either: mark them done for
      // today and come straight back for the next member rather than idling a full gap.
      const sock = sender.getSock?.();
      if (sock?.user && !(await stillInGroups(batch[0].phone, sock))) {
        log.info(`👋 Skipped ${batch[0].name} (${batch[0].phone}) — not in any group any more`);
        state.pushed = [...state.pushed, String(batch[0].phone)];
        state.left = [...(state.left || []), `${batch[0].name} ${batch[0].phone}`];
        saveState(state);
        return tick();
      }

      // Recorded only on a send that actually happened. A member whose message failed is
      // still owed one and must come back around, not be marked done by a socket hiccup.
      let ok = false;
      let why = 'socket not ready';
      try { ok = await autoSend(batch[0]); }
      catch (err) {
        why = err.message;
        log.error(`❌ Auto-send to ${batch[0].phone} failed: ${err.message}`);
      }
      if (!ok) {
        if (++failStreak >= FAIL_LIMIT) {
          state.stopped = true;
          saveState(state);
          clearTimer();
          log.error(`❌ Auto-send stopped — ${failStreak} failures in a row`);
          await notify(
            `🛑 *Auto-send stopped* — ${failStreak} sends failed in a row.\n` +
            `Last error: ${why}\n\n` +
            `Check the number can still message people before restarting. ` +
            `\`drip start\` resumes once you are sure.`);
          return;
        }
        return retrySoon();
      }
      failStreak = 0;
      state.pushed = [...state.pushed, String(batch[0].phone)];
      saveState(state);
      return scheduleNext(countRemaining({ members, config, pushed: state.pushed }));
    }

    const after = [...state.pushed, ...batch.map(r => String(r.phone))];
    await notify(renderDripBatch(batch, countRemaining({ members, config, pushed: after })));

    state.pushed = after;
    saveState(state);
    log.info(`💧 Pushed ${batch.length} link(s) — ${state.pushed.length} sent today`);
    scheduleNext();
  }

  // End of day. The report exists so a dead drip and a genuinely quiet day stop looking
  // identical from the operator's phone — silence is the one failure mode this design cannot
  // otherwise surface. It also makes the deliberate drop-not-carry visible: leftovers are not
  // queued for tomorrow, they simply arrive one day more overdue, which the 5/6/7 ladder
  // absorbs. Carrying them is what would let a backlog snowball.
  async function finish(state) {
    clearTimer();
    if (state.done) return;
    state.done = true;
    saveState(state);
    await store.refresh();
    const left = countRemaining({ members: store.getAll(), config, pushed: state.pushed });
    // The people who left are the reason the group check exists, and a check whose findings
    // nobody sees is a check that fixes one day and nothing after it. Named here so the
    // operator can kick them from the sheet and stop them coming back round tomorrow.
    const gone = state.left || [];
    await notify(
      `💧 *${auto ? 'Auto-send finished' : 'Drip finished'}* — ${friendlyDate()}\n` +
      `${state.pushed.length - gone.length} ${auto ? 'sent by the bot' : 'pushed'}` +
      (left > 0
        ? `, ${left} NOT reached today (they roll into tomorrow one day more overdue).`
        : `, nobody still waiting. 👍`) +
      (gone.length > 0
        ? `\n\n👋 *Left the groups — not messaged* (${gone.length}):\n${gone.join('\n')}\n` +
          `\`kick\` them so they stop coming round.`
        : ''),
    );
    log.info(`💧 ${auto ? 'Auto-send' : 'Drip'} finished — ${state.pushed.length} sent, ${left} unreached`);
  }

  // The drip and the Cloud API are alternatives, never a pair. Flipping reminderChannel to
  // "cloudapi" wakes the three reminder crons, which message the same members the drip is
  // queueing links for — leaving both on would send everyone the reminder twice, once from
  // Meta and once from the operator's thumb. Refusing here rather than only skipping the
  // cron matters because `drip start` is typed by hand.
  function cloudApiActive() {
    if (!usesCloudApi(config)) return false;
    log.info('💧 Drip inactive — reminders run through the Cloud API');
    return true;
  }

  // Called by the 9 AM cron. Auto-renew runs ONCE per day here, not per tick: a 2-referral
  // member owes nothing, and chasing them for money is a real error, not a cosmetic one.
  async function arm() {
    if (cloudApiActive()) return;
    const state = loadState();
    if (state.stopped) return log.info('💧 Drip is stopped — not arming');
    state.armedAt = new Date().toISOString();
    state.done = false;
    saveState(state);
    if (reminderSender?.autoRenewDue) {
      try {
        const renewed = await reminderSender.autoRenewDue(store, config.botDir);
        if (renewed.length) log.info(`💧 Auto-renewed ${renewed.length} member(s) before arming`);
      } catch (err) { log.warn(`⚠️  Auto-renew before drip failed: ${err.message}`); }
    }
    // One line at dawn, and only in auto mode, saying whether the day fits. The floor caps
    // the day at roughly window / (gapMin × 1.2) sends, and on a 929-member sheet the queue
    // can exceed that — at which point the tail is silently not sent. Silently is the problem:
    // the operator needs to see the number on the morning it happens, not infer it from a
    // member complaining a week later. The levers are all theirs — widen the window, raise
    // the ceiling, or clear the excess by hand with dmlist.
    if (auto) {
      try {
        const queued = countRemaining({ members: store.getAll(), config, pushed: state.pushed });
        const capacity = Math.floor(
          ((settings.endHour - settings.startHour) * 3600000) / (settings.gapMinMs * 1.2));
        if (queued > capacity) {
          await notify(
            `⚠️ *${queued} reminders queued, room for about ${capacity}* today.\n` +
            `The ${queued - capacity} at the back roll into tomorrow one day more overdue.\n` +
            `Clear them by hand with \`dmlist\` / \`dmlist2\` / \`dmlist3\` if you want them out today.`);
        }
      } catch (err) { log.warn(`⚠️  Capacity check failed: ${err.message}`); }
    }

    // Manual mode pushes the first links the moment it arms — the operator is awake and the
    // links only sit in Telegram until they tap. Auto mode transmits, so the first message of
    // the day must not land at a time anyone could set a watch by.
    if (auto) {
      const delay = randomBetween(0, settings.firstDelayMaxMs);
      log.info(`💧 Auto-send armed — first message in ${Math.round(delay / 60000)}m`);
      clearTimer();
      _timer = setTimeout(() => { tick().catch(err => log.error(`❌ Drip tick: ${err.message}`)); }, delay);
      if (_timer.unref) _timer.unref();
      return;
    }
    log.info('💧 Drip armed');
    await tick();
  }

  function stop() {
    const state = loadState();
    state.stopped = true;
    saveState(state);
    clearTimer();
    return '🛑 Drip stopped for today. `drip start` to resume.';
  }

  function start() {
    if (cloudApiActive()) {
      return 'ℹ️ Reminders run through the Cloud API on this bot — the drip is not used.';
    }
    const state = loadState();
    state.stopped = false;
    state.done = false;
    saveState(state);
    arm().catch(err => log.error(`❌ Drip start: ${err.message}`));
    return auto
      ? '💧 Auto-send started — the bot will send the first reminder shortly.'
      : '💧 Drip started — first links coming shortly.';
  }

  function status() {
    const state = loadState();
    const s = state.stopped ? '🛑 stopped' : state.done ? '✅ finished' : '💧 running';
    const what = auto ? 'sent by the bot' : 'pushed';
    return `${s} · ${auto ? '🤖 auto-send' : '👍 manual links'} — ${state.pushed.length} ${what} today ` +
      `(window ${settings.startHour}:00–${settings.endHour}:00, ` +
      `${auto ? `≥${Math.round(settings.gapMinMs / 60000)}m apart, gap adapts to the queue` :
                `${Math.round(settings.gapMinMs / 60000)}-${Math.round(settings.gapMaxMs / 60000)}m apart`})`;
  }

  // `drip test` — push ONE real batch right now and change nothing.
  //
  // Ignores the window, does not persist to state.pushed, does not schedule a next tick and
  // does not auto-renew. Without it, checking that the notifications work means waiting for
  // a 9 AM cron and then 20 minutes per push. Because it records nothing, the members it
  // shows still get their real push later — running it never costs anyone a reminder.
  async function test() {
    if (cloudApiActive()) {
      return 'ℹ️ Reminders run through the Cloud API on this bot — the drip is not used.';
    }
    await store.refresh();
    const state = loadState();
    const members = store.getAll();
    const batch = buildDripBatch({ members, config, pushed: state.pushed });
    if (batch.length === 0) return '✅ Nothing to send right now — nobody due, overdue or final.';
    // Still a Telegram preview in auto mode, deliberately: `drip test` exists to show the
    // operator what the next tick would do, and a test that really messaged a member would
    // cost them their reminder and spend a slot.
    const sent = await notify(
      '🧪 *TEST — not recorded, these will still be sent for real later*\n\n' +
      renderDripBatch(batch, countRemaining({ members, config, pushed: state.pushed })),
    );
    return sent
      ? `🧪 Test push sent to Telegram — ${batch.length} link(s). Nothing was recorded.`
      : '⚠️ No Telegram listener — nothing was sent.';
  }

  // A restart mid-window must not silently end the day. Nothing replays: `pushed` is
  // persisted, so resuming picks up exactly where it left off.
  function resume() {
    if (cloudApiActive()) return;
    const state = loadState();
    if (state.stopped || state.done || !state.armedAt) return;
    if (!withinWindow(new Date(), settings)) return;
    log.info(`💧 Resuming ${auto ? 'auto-send' : 'drip'} after restart`);
    // The adaptive gap needs a queue length, and after a restart the only honest one comes
    // from the sheet as it stands. Passing 0 would hand back the 2h cap and idle away the
    // rest of the window. store.getAll() is the cache the last refresh filled — a tick will
    // refresh it properly before anything is sent.
    scheduleNext(auto ? countRemaining({ members: store.getAll(), config, pushed: state.pushed }) : 0);
  }

  return { arm, start, stop, status, resume, tick, test };
}
