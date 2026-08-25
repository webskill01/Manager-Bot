import fs from 'fs';
import path from 'path';
import { randomBetween, todayStr, friendlyDate, sleep, normalizePhone, pickVariant, resolveWhatsAppJid } from './globalConfig.js';
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
  // Due-today cohort FIRST, then the nudge, then the final notice. Irrelevant when all three
  // go out together; decisive when `max` is 1, as auto mode sets it.
  //
  // This used to run most-overdue-first, reasoning that a day-6 member has one day left
  // before removal. The operator's call, and the right one: the day-0 reminder is the one
  // that actually collects money, and on a day the queue overflows the window it was the
  // renewals — not the chase-ups — that were silently dropped. A missed day-0 member becomes
  // a nudge tomorrow; a missed day-6 member is already a decision (the removal list), which
  // `overdue`/`kickall` handle. Follow-ups are the lower-value half of the queue, so they
  // are the half that gets squeezed.
  for (const cohort of ['due', 'nudge', 'final']) {
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

// Today's whole queue, in the exact order the drip will work it: every 'due' row, then
// every 'nudge', then every 'final' — the same cohort order buildDripBatch drains, so the
// plan and the day cannot disagree. Deduped across cohorts like countRemaining.
export function buildDripQueue({ members, config, pushed = [], now = todayStr() }) {
  const seen = new Set(pushed.map(String));
  const queue = [];
  for (const cohort of ['due', 'nudge', 'final']) {
    for (const r of buildDmList({ members, config, cohort, now }).rows) {
      if (seen.has(String(r.phone))) continue;
      seen.add(String(r.phone));
      queue.push(r);
    }
  }
  return queue;
}

// Estimated clock time for each member in the queue.
//
// Estimates, and labelled as such wherever they are printed: the gap is redrawn every tick
// from the queue as it stands THEN, and carries up to +40% of deliberate wobble. A member who
// pays at noon leaves the queue and pulls everyone behind them earlier. What IS exact is the
// ORDER, which is the half the operator actually needs to check the day against.
//
// The wobble is applied to the FLOOR and the cap, never to an even split. adaptiveGapMs
// re-divides the time actually left by the queue actually left on every tick, so inflating
// one gap shortens the next one and an evenly-paced day still lands on the window's edge.
// Only a gap pinned at the floor — a queue longer than the window can hold — really pushes
// the day out past its end, which is exactly the case `late` is here to find.
//
// Multiplying an even split by 1.2 as well made the plan cry wolf: eight members across
// twelve hours came out as 14.4 hours of sends and reported as overflowing.
export function planTimes(queue, settings, { from = new Date(), endHour } = {}) {
  const end = new Date(from);
  end.setHours(endHour ?? settings.endHour, 0, 0, 0);
  const WOBBLE = 1.2;   // mean of the +0..40% adaptiveGapMs adds, so times land mid-spread
  let at = from.getTime();
  return queue.map((row, i) => {
    const remaining = queue.length - i;
    const even = remaining > 0 ? (end - at) / remaining : settings.gapCapMs * WOBBLE;
    const gap = Math.min(
      Math.max(even, settings.gapMinMs * WOBBLE),
      settings.gapCapMs * WOBBLE,
    );
    at += gap;
    return { ...row, at: new Date(at), late: at > end.getTime() };
  });
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
// "Assume it arrived" — the behaviour before delivery was ever checked. Used when index.js
// wires no tracker, so core/telegram.js and every existing test are unaffected by this.
const NO_TRACKER = { verdict: () => ({ ok: true, status: null }) };

export function createDripEngine(config, log, store, reminderSender, notify, sender = null) {
  const tracker = sender?.tracker || NO_TRACKER;
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
  // Hand ONE member to the operator's thumb, as a tap-to-send link.
  //
  // The bot failing to reach someone is not a reason for that person to go unchased. wa.me
  // opens the chat with the message already typed on the operator's own phone, which is a
  // human opening a conversation rather than a linked device reaching out — a different path
  // entirely, and the one that still works while the account is restricted from reachouts.
  //
  // Marked handled immediately, with no confirmation step: the operator's standing
  // instruction is that a link they are sent is a message they send. A confirm button would
  // buy a bit of bookkeeping accuracy at the cost of a second interaction per member, ~30 a
  // day, which is how `dmlist done` ended up being forgotten in the first place.
  async function handToOperator(row, reason) {
    await notify(
      `📤 *Send it yourself* — the bot could not reach them\n` +
      `${STAGE_LABEL[row.stage]} · ${row.name} · ₹${row.fee} · ` +
      `${row.overdueDays === 0 ? 'due today' : `${row.overdueDays}d overdue`}\n` +
      `_${reason}_\n\n${row.link}` +
      (needsQr(row, firstContact(row)) ? '\n\n📷 Attach the QR — they have not had one this month.' : ''));
    log.info(`📤 Handed ${row.name} (${row.phone}) to the operator — ${reason}`);
  }

  // The previous auto-send, held until the next tick can ask whether it landed. In memory on
  // purpose: a restart loses at most one pending check, and persisting it would mean a file
  // write per send to buy back one line of an evening report.
  let lastSend = null;

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
    return sock.sendMessage(jid, content);
  }

  // One reminder, sent by the bot. Returns false rather than throwing when the socket is not
  // there, so tick() can retry the same member shortly instead of burning their slot.
  async function autoSend(row) {
    const sock = sender.getSock?.();
    if (!sock?.user) {
      log.warn('💧 Auto-send held — WhatsApp socket not ready');
      return false;
    }
    // Ask WhatsApp where this person actually is. The concatenated phone JID stays as the
    // fallback and NOTHING skips a member on a failed lookup — same asymmetry as the roster
    // check: wrongly skipping someone who pays is invisible and costs real money, so only an
    // explicit "this number does not exist" is allowed to stop a send.
    let jid = `91${normalizePhone(row.phone)}@s.whatsapp.net`;
    try {
      const found = await resolveWhatsAppJid(sock, row.phone);
      if (!found.exists) return 'unreachable';
      if (found.jid !== jid) {
        log.info(`📱 ${row.phone} addressed as ${found.jid} (not the phone JID)`);
      }
      jid = found.jid;
    } catch (err) {
      log.warn(`⚠️  JID lookup failed for ${row.phone} — sending to the phone JID: ${err.message}`);
    }

    // The QR rides msg1, once per billing CYCLE — see needsQr. The nudge and the final notice
    // go to someone who has it in this very chat, a scroll away, so re-sending buys nothing
    // and costs a second and third image. Media is the heaviest thing this bot transmits and
    // the easiest to fingerprint, so roughly two thirds of them stop existing.
    //
    // upiQrPath may be a LIST. Same payee, different bytes: WhatsApp identifies media by file
    // hash, so one identical image landing on 600 phones is a far louder signal than any
    // repeated wording. pickVariant is keyed on phone, so a member always gets the same one.
    const first = firstContact(row);
    const wantsQr = needsQr(row, first);
    const qr = wantsQr ? pickVariant(config.upiQrPath, row.phone) : null;
    const qrPath = qr ? path.resolve(config.botDir, qr) : null;
    const withQr = !!(qrPath && fs.existsSync(qrPath));
    const content = withQr
      ? { image: fs.readFileSync(qrPath), caption: row.text }
      : { text: row.text };

    const receipt = await sendLikeHuman(sock, jid, content, row.text);
    // Recorded only AFTER the send lands. A QR marked sent on a message that threw would
    // leave that member without one for the whole cycle.
    noteSent(row, withQr);
    // The QR tag says WHY, not just whether. "+QR" on nine sends in a row looks identical to
    // a broken gate from the log alone, which is exactly how this got reported as a bug.
    const tag = withQr ? (row.stage === 'msg1' ? ' +QR (msg1)' : ' +QR (first contact this cycle)') : '';

    // Held so the NEXT tick can ask whether this one actually arrived. sendMessage resolving
    // only means the server took the node off our hands — see deliveryTracker. Checking on
    // the next tick rather than on a timer gives a free 15-45 minute grace period, which is
    // what stops a recipient with their phone off being reported as a failure.
    lastSend = receipt?.key?.id
      ? { id: receipt.key.id, name: row.name, phone: row.phone, at: Date.now(), row }
      : null;
    if (!lastSend) log.warn(`⚠️  No message id back for ${row.phone} — delivery cannot be confirmed`);

    log.info(`💧 Auto-sent ${STAGE_LABEL[row.stage]} → ${row.name} (${row.phone})${tag}`);
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

  // phone → { cycle, qr }: the last billingDate we messaged them in, and the last one we
  // attached a QR in. Two fields rather than one because "have they heard from us this
  // cycle" and "do they already have the QR" are different questions — see needsQr.
  //
  // Reads tolerate the old flat `{ phone: "DD-MM-YYYY" }` shape (one QR date, no contact
  // record) so an upgrade does not hand everyone a second QR. ponytail: no migration step,
  // the shim is three lines and the file rewrites itself on the next send.
  function loadQrLog() {
    try {
      const raw = JSON.parse(fs.readFileSync(qrFile, 'utf8'));
      const out = {};
      for (const [phone, v] of Object.entries(raw)) {
        out[phone] = typeof v === 'string' ? { cycle: v, qr: v } : v;
      }
      return out;
    } catch { return {}; }
  }

  function saveQrLog(log_) {
    try { fs.writeFileSync(qrFile, JSON.stringify(log_, null, 2)); }
    catch (err) { log.warn(`⚠️  QR log write failed: ${err.message}`); }
  }

  // Nothing on record for the cycle they are in right now.
  function firstContact(row) {
    return loadQrLog()[String(row.phone)]?.cycle !== row.billingDate;
  }

  // Exactly ONE QR per member per billing cycle, and it rides msg1 wherever msg1 happens.
  //
  // Two conditions, both required:
  //   1. nothing logged for this member's current cycle, and
  //   2. this is msg1 — OR the member has had no contact at all this cycle, in which case
  //      whatever reaches them first carries it.
  //
  // (2)'s second half is not a loophole, it is the money. A member missed on their due date
  // never gets msg1 at all — the 'due' cohort is exactly day 0 — so their first ever contact
  // is the day-5 nudge. A strict msg1-only gate chased that person for ₹90 twice with no way
  // to pay. The ceiling is still one image per cycle either way; this only decides WHICH
  // message carries it.
  //
  // Their billingDate is the cycle id: it moves forward the moment they renew, so next
  // month's first message carries a QR again with nothing to reset or expire.
  function needsQr(row, firstContactThisCycle) {
    if (loadQrLog()[String(row.phone)]?.qr === row.billingDate) return false;
    return row.stage === 'msg1' || firstContactThisCycle;
  }

  // One write, after the send lands, recording both facts at once. `withQr` false still
  // records the contact — that is what stops a day-6 member who was nudged on day 5 from
  // being treated as a first contact and handed a second image.
  function noteSent(row, withQr) {
    const log_ = loadQrLog();
    const prev = log_[String(row.phone)] || {};
    log_[String(row.phone)] = {
      cycle: row.billingDate,
      qr: withQr ? row.billingDate : prev.qr,
    };
    saveQrLog(log_);
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

    // Did the PREVIOUS one land? Asked here rather than on a timer because the gap to this
    // tick is 15-45 minutes, which is a generous grace period for free. A hard failure means
    // the message never left and is worth a buzz; a soft one is indistinguishable from the
    // recipient having their phone off, so it only goes in tonight's count. See
    // deliveryTracker for why those two must not be reported the same way.
    if (auto && lastSend) {
      const prev = lastSend;
      lastSend = null;
      const { ok, hard, fatal, why, detail } = tracker.verdict(prev.id);
      if (!ok) {
        log.warn(`⚠️  ${prev.name} (${prev.phone}) — ${why}`);
        state.undelivered = [...(state.undelivered || []), `${prev.name} ${prev.phone} — ${why}`];
        saveState(state);

        // Retroactive handoff. The bot believed this one went; it did not, and the member is
        // still owed their reminder — so it goes to the operator like any other failure
        // rather than being left as a line in tonight's report.
        if (prev.row) await handToOperator(prev.row, why);

        // A fatal code is about the ACCOUNT, not this member: every further attempt today
        // gets the same rejection. The day does NOT stop — the queue keeps its pacing and
        // every member still gets chased — but the bot stops ATTEMPTING and hands the whole
        // remaining queue over as links.
        //
        // That distinction is the point. Continuing to fire rejected reachouts at a number
        // WhatsApp has already restricted is what turns a restriction into a ban, and it buys
        // nothing, because not one of them can land. Going link-only keeps the collection
        // running at full rate while the account stops digging.
        if (fatal && !state.linkOnly) {
          state.linkOnly = true;
          state.linkOnlyReason = why;
          saveState(state);
          log.warn(`📤 Switching to link-only for the rest of today — ${why}`);
          await notify(
            `📤 *Handing today over to you* — ${why}

${detail || ''}

` +
            `The bot will keep working the queue on the same schedule, but it will send you ` +
            `a tap-to-send link for each person instead of messaging them itself. Nothing ` +
            `stops and nobody is skipped — you just become the last step.`);
        }
      }
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
        // Said now, not only in tonight's summary. These are the two things the operator can
        // actually act on the same day — kick them from the sheet, or fix a wrong number —
        // and a line buried in pm2 logs is a line nobody reads. The end-of-day report keeps
        // listing them too, so a missed push is not a lost record.
        await notify(
          `👋 *${batch[0].name}* (${batch[0].phone}) is not in any group any more — not messaged.\n` +
          `\`kick ${batch[0].phone}\` so they stop coming round.`);
        return tick();
      }

      // Link-only: the account is restricted, so an attempt would be a rejected reachout and
      // nothing else. Skip straight to the operator, keep the pacing, keep the queue moving.
      if (state.linkOnly) {
        await handToOperator(batch[0], state.linkOnlyReason || 'the bot cannot send today');
        state.pushed = [...state.pushed, String(batch[0].phone)];
        state.handed = [...(state.handed || []), `${batch[0].name} ${batch[0].phone}`];
        saveState(state);
        return scheduleNext(countRemaining({ members, config, pushed: state.pushed }));
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

      // WhatsApp says there is no account on that number. Not a failure to retry — retrying
      // it every five minutes would burn the day on one bad row — and emphatically not a
      // silent success either. Mark it handled, name it in tonight's report, move on.
      if (ok === 'unreachable') {
        log.warn(`📵 ${batch[0].name} (${batch[0].phone}) is not on WhatsApp — nothing sent`);
        state.pushed = [...state.pushed, String(batch[0].phone)];
        state.unreachable = [...(state.unreachable || []), `${batch[0].name} ${batch[0].phone}`];
        saveState(state);
        await notify(
          `📵 *${batch[0].name}* (${batch[0].phone}) is not on WhatsApp — nothing could be sent.\n` +
          `Check the number in the sheet, or \`skip ${batch[0].phone}\`.`);
        return tick();
      }

      if (!ok) {
        // A socket that is merely not ready yet is worth ONE quick retry — a reconnect takes
        // seconds and the member keeps their slot. Anything else, or a second failure, goes
        // straight to the operator: the member is owed their reminder today, and which
        // channel carries it matters far less than whether it arrives at all.
        const firstTry = !(state.retried || []).includes(String(batch[0].phone));
        if (firstTry && /socket/i.test(why)) {
          state.retried = [...(state.retried || []), String(batch[0].phone)];
          saveState(state);
          return retrySoon();
        }

        await handToOperator(batch[0], why);
        state.pushed = [...state.pushed, String(batch[0].phone)];
        state.handed = [...(state.handed || []), `${batch[0].name} ${batch[0].phone}`];
        saveState(state);

        // The streak still matters, but it now means "the bot cannot send at all today"
        // rather than "stop chasing people". Five in a row flips the whole day to link-only,
        // which keeps every remaining member on schedule without another rejected reachout.
        if (++failStreak >= FAIL_LIMIT && !state.linkOnly) {
          state.linkOnly = true;
          state.linkOnlyReason = why;
          saveState(state);
          log.warn(`📤 ${failStreak} failures in a row — link-only for the rest of today`);
          await notify(
            `📤 *Handing today over to you* — ${failStreak} sends failed in a row.\n` +
            `Last error: ${why}\n\n` +
            `The bot will keep working the queue on the same schedule and send you a link ` +
            `for each person instead of messaging them itself. Nobody is skipped.`);
        }
        return scheduleNext(countRemaining({ members, config, pushed: state.pushed }));
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
    // Numbers WhatsApp has no account for. Separate from `gone` because the fix is different:
    // someone who left the groups gets kicked from the sheet, someone whose number is dead
    // needs the number corrected or the member removed. Both used to be invisible.
    const dead = state.unreachable || [];
    // Sent, believed delivered, and never confirmed. The only failure mode the bot used to
    // report as a success.
    const lost = state.undelivered || [];
    // Sent by the operator's thumb instead of the socket. Not a failure — a different
    // delivery path — so they are counted apart from both the sent and the lost.
    const handed = state.handed || [];
    await notify(
      `💧 *${auto ? 'Auto-send finished' : 'Drip finished'}* — ${friendlyDate()}\n` +
      `${state.pushed.length - gone.length - dead.length - handed.length} ` +
      `${auto ? 'sent by the bot' : 'pushed'}` +
      (handed.length > 0 ? `, ${handed.length} handed to you` : '') +
      (left > 0
        ? `, ${left} NOT reached today (they roll into tomorrow one day more overdue).`
        : `, nobody still waiting. 👍`) +
      (gone.length > 0
        ? `\n\n👋 *Left the groups — not messaged* (${gone.length}):\n${gone.join('\n')}\n` +
          `\`kick\` them so they stop coming round.`
        : '') +
      (dead.length > 0
        ? `\n\n📵 *Not on WhatsApp — nothing could be sent* (${dead.length}):\n${dead.join('\n')}\n` +
          `Check the number in the sheet, or \`skip\` them.`
        : '') +
      // The line that would have caught this on day one. Everything above is a message the
      // bot knowingly did not send; this is one it believed it had.
      (handed.length > 0
        ? `\n\n📤 *Handed to you as links* (${handed.length}):\n${handed.join('\n')}\n` +
          (state.linkOnly ? `Reason: ${state.linkOnlyReason}` : '')
        : '') +
      (lost.length > 0
        ? `\n\n⚠️ *Sent but NOT confirmed delivered* (${lost.length} of ${state.pushed.length}):\n` +
          `${lost.join('\n')}\n` +
          `Re-send with \`remind [phone]\`. If this list is most of the day, the number is ` +
          `being filtered rather than these members being offline.`
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

  // ── Handing a batch to the operator ────────────────────────────────────────
  //
  // `dmlist` prints tap-to-send links and writes nothing, because printing is not sending and
  // the bot cannot know how far a thumb got. Fine while the bot sent nothing itself; not fine
  // now, because the operator clearing an overflow by hand at noon and the auto-sender
  // reaching the same person at 4 PM is a double message — the exact thing this whole rework
  // exists to avoid.
  //
  // So: dmlist records who it SHOWED, and `dmlist done` promotes that list to "handled
  // today". Two steps rather than one because merely looking at the list must not silence
  // the bot for those people — running dmlist to check who is due would otherwise cost a
  // day-0 member their only message, the day-1-to-4 range matching no cohort at all.
  function rememberShown(phones) {
    const state = loadState();
    state.shown = [...new Set(phones.map(String))];
    saveState(state);
  }

  function markShownHandled() {
    const state = loadState();
    const shown = state.shown || [];
    if (shown.length === 0) {
      return 'ℹ️ Nothing to mark — run `dmlist`, `dmlist2` or `dmlist3` first, then send them.';
    }
    const already = new Set(state.pushed.map(String));
    const fresh = shown.filter(p => !already.has(p));
    state.pushed = [...state.pushed, ...fresh];
    state.shown = [];
    saveState(state);
    const rest = countRemaining({ members: store.getAll(), config, pushed: state.pushed });
    return `✅ ${fresh.length} marked as sent by you today — ${auto ? 'the bot' : 'the drip'} ` +
      `will skip them.\n${rest} still queued.`;
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

    // Can it send RIGHT NOW? linkOnly only appears AFTER a send has already been rejected,
    // and a dead socket or a warm-up hold looks exactly like a quiet day from the outside —
    // on 25-08-2026 the bot was down most of the day and `drip` said "running" throughout.
    // Ask the socket directly, so this answers the question without messaging a member.
    const down = !auto ? ''
      : !sender.getSock?.()?.user
        ? '⚠️ WhatsApp is DISCONNECTED — nothing can be auto-sent until it reconnects.\n' +
          '   `dmlist` still works — send them yourself.\n\n'
        : sender.warmingUp?.()
          ? '🐣 Warm-up — auto-send is HELD until the number has aged. Nothing is going out.\n\n'
          : '';
    const s = state.stopped ? '🛑 stopped' : state.done ? '✅ finished' : '💧 running';
    if (state.linkOnly) {
      return `${down}${s} · 📤 LINK-ONLY — ${state.linkOnlyReason}\n` +
        `${(state.handed || []).length} handed to you today, ${state.pushed.length} done in total.\n` +
        `The bot is still pacing the queue; it sends you a link instead of messaging them.`;
    }
    const what = auto ? 'sent by the bot' : 'pushed';
    return `${down}${s} · ${auto ? '🤖 auto-send' : '👍 manual links'} — ${state.pushed.length} ${what} today ` +
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

  // `drip plan` — what the rest of today looks like, before it happens.
  //
  // Exists because "is it working or is it random?" is unanswerable from the outside: the
  // gaps ARE random by design, so the operator had no way to tell a healthy day from a stuck
  // one until the evening report. The ORDER and the MEMBERS are fully determined, so print
  // those as fact and the times as estimates, and the day becomes checkable at 6 AM.
  //
  // Reads the sheet, writes nothing — safe to run at any hour, as often as you like.
  async function plan() {
    if (cloudApiActive()) {
      return 'ℹ️ Reminders run through the Cloud API on this bot — the drip is not used.';
    }
    await store.refresh();
    const state = loadState();
    const queue = buildDripQueue({ members: store.getAll(), config, pushed: state.pushed });

    const head = `📋 *Today’s plan* — ${friendlyDate()}  ·  ` +
      `${auto ? '🤖 bot sends' : '👍 links to you'}, ` +
      `${settings.startHour}:00–${settings.endHour}:00\n`;

    if (state.stopped) return `${head}\n🛑 Stopped for today. \`drip start\` to resume.`;
    if (queue.length === 0) {
      return `${head}\n✅ Nothing left — ${state.pushed.length} already handled today, ` +
        `nobody else due, overdue or final.`;
    }

    // Start from now, or from the window opening if the day has not begun. Not from the armed
    // timer: that delay is drawn randomly and re-drawn on restart, so pretending to know it
    // would make the first row the least accurate one on the list.
    const now = new Date();
    const open = new Date(now);
    open.setHours(settings.startHour, 0, 0, 0);
    const from = now < open ? open : now;

    const rows = planTimes(queue, settings, { from });
    const fits = rows.filter(r => !r.late);
    const spill = rows.filter(r => r.late);
    const qrLog = loadQrLog();

    const line = (r, i) => {
      const t = r.at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const cyc = qrLog[String(r.phone)] || {};
      const qr = (cyc.qr !== r.billingDate && (r.stage === 'msg1' || cyc.cycle !== r.billingDate))
        ? ' 📷' : '';
      const age = r.overdueDays === 0 ? 'due today' : `${r.overdueDays}d over`;
      return `${String(i + 1).padStart(3)}. ~${t}  ${STAGE_LABEL[r.stage]} · ${r.name} · ₹${r.fee} · ${age}${qr}`;
    };

    const body = fits.map(line).join('\n');
    const tail = spill.length > 0
      ? `\n\n⚠️ *${spill.length} will NOT fit before ${settings.endHour}:00* — they roll into ` +
        `tomorrow one day more overdue:\n` +
        spill.map(r => `   · ${r.name} (${r.overdueDays}d)`).join('\n') +
        `\nClear them by hand with \`dmlist\` / \`dmlist2\` / \`dmlist3\` to get them out today.`
      : '';

    return `${head}${state.pushed.length} done · ${queue.length} to go · order is exact, ` +
      `times are estimates (📷 = carries the QR)\n━━━━━━━━━━━━━━━━━\n${body}${tail}`;
  }

  // A restart mid-window must not silently end the day. Nothing replays: `pushed` is
  // persisted, so resuming picks up exactly where it left off.
  function resume() {
    if (cloudApiActive()) return;
    const state = loadState();
    if (state.stopped || state.done) return;
    if (!withinWindow(new Date(), settings)) return;

    // Never armed today. node-cron does not replay a firing the process was not alive for,
    // so a bot that was down across 6 AM and came up at 10 used to sit out the whole day with
    // `status` cheerfully reporting "running" — the queue simply rolled to tomorrow, everyone
    // a day more overdue, and nothing anywhere said so. Arming here is safe precisely because
    // `done` and `stopped` are checked above: a finished or stopped day never reaches this.
    if (!state.armedAt) {
      log.info('💧 Missed the arm cron — the bot was down for it. Arming now.');
      arm().catch(err => log.error(`❌ Drip late-arm: ${err.message}`));
      return;
    }

    // A timer is ALREADY pending, so this is a socket reconnect, not a process restart —
    // and the two are indistinguishable from here because index.js fires resume() on every
    // 'open'. Falling through would clearTimer() and draw a fresh full gap, pushing the next
    // member back by up to 45 minutes EVERY reconnect. bot-nitin took 7 reconnects in one
    // four-hour stretch; had they landed inside the send window rather than overnight, most
    // of the day's queue would simply never have gone out.
    //
    // In-process state is the right test here, not anything on disk: a real restart has no
    // timer because it has no previous process.
    if (_timer) return;

    log.info(`💧 Resuming ${auto ? 'auto-send' : 'drip'} after restart`);
    // The adaptive gap needs a queue length, and after a restart the only honest one comes
    // from the sheet as it stands. Passing 0 would hand back the 2h cap and idle away the
    // rest of the window. store.getAll() is the cache the last refresh filled — a tick will
    // refresh it properly before anything is sent.
    scheduleNext(auto ? countRemaining({ members: store.getAll(), config, pushed: state.pushed }) : 0);
  }

  return { arm, start, stop, status, plan, resume, tick, test, rememberShown, markShownHandled };
}
