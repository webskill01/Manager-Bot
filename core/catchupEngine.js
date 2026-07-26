import fs from 'fs';
import path from 'path';
import {
  daysFromToday, formatDate, todayStr, randomBetween,
  overdueCohort, renewedOn, friendlyDate, sleep,
} from './globalConfig.js';
import { buildGroupDigest } from './reminderSender.js';

// One catch-up "stage" per day: the same three group messages the daily digest
// normally spreads across a member's cycle, compressed into three consecutive days
// for a cohort that missed them entirely while the bot was offline.
const STAGES = [
  { key: 'reminder', label: 'payment reminder', headerKey: 'groupReminder', withQr: true },
  { key: 'overdue',  label: 'overdue notice',   headerKey: 'groupOverdue',  withQr: false },
  { key: 'final',    label: 'final notice',     headerKey: 'groupFinal',    withQr: false },
];

// Grace applied to the cohort at start: covers all three stages (days 0,1,2) plus one
// buffer day, so nobody is removed mid-sequence or the moment the last message lands.
const GRACE_DAYS = 3;

// Hard cap on @mentions in one message. Batches are normally one billing date (~10-20
// people over an 8-day outage); this only bites when a single date is unusually crowded.
const MAX_TAGS_PER_MSG = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCatchupEngine(config, log, getSock, store) {
  const stateFile = path.join(config.botDir, 'catchup-state.json');
  let _timeout = null;
  let _running = false;

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) { log.warn(`⚠️  Catchup state read failed: ${err.message}`); }
    return null;
  }

  function saveState(state) {
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    catch (err) { log.error(`❌ Catchup state save failed: ${err.message}`); }
  }

  function deleteState() {
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }
    catch (err) { log.warn(`⚠️  Catchup state delete failed: ${err.message}`); }
  }

  function clearTimer() {
    if (_timeout) clearTimeout(_timeout);
    _timeout = null;
  }

  // Catch-up posts to the group, never to individuals — that's the whole point.
  function groupCfg() {
    const r = config.reminder;
    if (!r || r.mode !== 'group' || !r.groupId) return null;
    return r;
  }

  function headerFor(stage, billingDate = null) {
    const m = config.messages || {};
    // groupFinal is optional — a bot that never configured it falls back to its
    // overdue wording rather than failing the last (most important) stage.
    const raw = m[stage.headerKey] || m.groupOverdue || '🚨 Renewal pending — please repay';
    // {date} renders the BATCH's billing date, not today's: every message goes to one
    // date's cohort, so "21 July — your renewal date came" is literally true for everyone
    // tagged in it.
    return raw.replace('{date}', billingDate ? friendlyDate(billingDate) : new Date().toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
    }));
  }

  // One message per billing date. Tagging 115 people in a single message is unreadable for
  // members and a textbook bulk-mention spam signal; a date-sized batch is ~10-20 people and
  // the message is actually true for all of them. A single date with more than
  // MAX_TAGS_PER_MSG members is chunked further.
  function batchByBillingDate(members) {
    const byDate = new Map();
    for (const m of members) {
      if (!byDate.has(m.billingDate)) byDate.set(m.billingDate, []);
      byDate.get(m.billingDate).push(m);
    }
    const batches = [];
    // Oldest billing date first — they've been waiting longest.
    const dates = [...byDate.keys()].sort((a, b) => daysFromToday(a) - daysFromToday(b));
    for (const date of dates) {
      const group = byDate.get(date);
      for (let i = 0; i < group.length; i += MAX_TAGS_PER_MSG) {
        const slice = group.slice(i, i + MAX_TAGS_PER_MSG);
        batches.push({
          date,
          part: group.length > MAX_TAGS_PER_MSG ? Math.floor(i / MAX_TAGS_PER_MSG) + 1 : null,
          key: `${date}#${Math.floor(i / MAX_TAGS_PER_MSG)}`,
          members: slice,
        });
      }
    }
    return batches;
  }

  // Reuses the digest's inter-message spacing so a stage never lands as one burst.
  function batchGapMs() {
    return randomBetween(
      config.reminder?.msgGapMinMs ?? 4 * 60000,
      config.reminder?.msgGapMaxMs ?? 6 * 60000,
    );
  }

  // Re-derived from the live sheet at every stage, never trusted from the state file:
  // anyone who paid since the cohort was frozen has had their billing date advanced by
  // `renewed`, so they simply stop matching and drop out silently.
  function stillUnpaid(state) {
    const today = todayStr();
    const byPhone = new Map(store.getAll().map(m => [m.phone, m]));
    return state.cohort
      .map(c => byPhone.get(c.phone))
      .filter(m => m
        && m.status === 'ACTIVE'
        && daysFromToday(m.billingDate) < 0
        && !renewedOn(m, today))
      .map(m => ({
        name: m.name,
        phone: m.phone,
        billingDate: m.billingDate,
        note: `— ${Math.abs(daysFromToday(m.billingDate))} din overdue`,
      }));
  }

  function buildCohort(windowDays) {
    return overdueCohort(store.getAll(), windowDays);
  }

  async function preview(windowDays) {
    if (!groupCfg()) {
      return '❌ catchup works in group reminder mode only — set reminder.mode to "group" and fill reminder.groupId in this bot\'s config.';
    }
    if (loadState()) return `⚠️ A catch-up cycle is already running.\n\n${status()}`;

    await store.refresh();
    const cohort = buildCohort(windowDays);
    if (cohort.length === 0) {
      return `✅ Nobody fell due in the last ${windowDays} days and is still unpaid — nothing to catch up on.`;
    }

    // Show the batching, not 115 names — the batch shape is the decision being made here.
    const batches = batchByBillingDate(cohort);
    const lines = batches.map(b =>
      `  ${friendlyDate(b.date)}${b.part ? ` (part ${b.part})` : ''} — ${b.members.length} member(s), ${Math.abs(daysFromToday(b.date))}d overdue`);

    const gapMin = Math.round((config.reminder?.msgGapMinMs ?? 4 * 60000) / 60000);
    const gapMax = Math.round((config.reminder?.msgGapMaxMs ?? 6 * 60000) / 60000);
    const perStageMin = Math.round(((batches.length - 1) * gapMin));
    const perStageMax = Math.round(((batches.length - 1) * gapMax));

    return `📣 CATCHUP PREVIEW — ${cohort.length} member(s) missed while the bot was down\n\n` +
      `Split into ${batches.length} message(s), one per renewal date:\n${lines.join('\n')}\n\n` +
      `Nobody is tagged with people who have a different date, and no message\n` +
      `tags more than ${MAX_TAGS_PER_MSG}. Messages are ${gapMin}–${gapMax} min apart\n` +
      `(~${perStageMin}–${perStageMax} min per stage).\n\n` +
      `Plan (group messages only — no DMs):\n` +
      `  Stage 1 → ${STAGES[0].label}${STAGES[0].withQr ? ' + QR' : ''}\n` +
      `  Stage 2 → ${STAGES[1].label}   (next day)\n` +
      `  Stage 3 → ${STAGES[2].label}    (day after)\n\n` +
      `All ${cohort.length} delayed ${GRACE_DAYS} days so nobody is removed mid-sequence.\n` +
      `Billing dates are NOT changed. Anyone who pays drops out of later stages.\n\n` +
      `To start: catchup ${windowDays} confirm      (first message now)\n` +
      `      or: catchup ${windowDays} confirm 9    (first message at 9 AM)`;
  }

  // Next occurrence of `hour` (0–23) local time. Today if it hasn't passed, else tomorrow.
  function nextHourSlot(hour) {
    const t = new Date();
    t.setMinutes(0, 0, 0);
    t.setHours(hour);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t;
  }

  async function start(windowDays, startHour = null) {
    if (!groupCfg()) {
      return '❌ catchup works in group reminder mode only — set reminder.mode to "group" and fill reminder.groupId in this bot\'s config.';
    }
    if (loadState()) return `⚠️ A catch-up cycle is already running.\n\n${status()}`;

    await store.refresh();
    const cohort = buildCohort(windowDays);
    if (cohort.length === 0) {
      return `✅ Nobody fell due in the last ${windowDays} days and is still unpaid — nothing to catch up on.`;
    }

    // Grace is applied NOW even when the first message is deferred: the whole point of a
    // deferred start is that you can arm this at midnight and have the cohort already
    // protected from the 6:30 digest and the removal list before it fires.
    // Counted from the first message day, so the last stage still lands inside the window.
    const firstSlot = startHour === null ? new Date() : nextHourSlot(startHour);
    const until = new Date(firstSlot);
    until.setHours(0, 0, 0, 0);
    until.setDate(until.getDate() + GRACE_DAYS);
    const delayUntil = formatDate(until);

    let delayed = 0;
    for (const m of cohort) {
      try {
        await store.update(m.phone, { delayUntil }, { skipRefresh: true });
        delayed++;
      } catch (err) { log.warn(`⚠️  Catchup delay failed for ${m.phone}: ${err.message}`); }
    }
    await store.refresh();

    const deferred = startHour !== null;
    const state = {
      startedAt: new Date().toISOString(),
      windowDays,
      delayUntil,
      startHour,
      stage: 0,
      cohort: cohort.map(m => ({ name: m.name, phone: m.phone })),
      log: [],
    };
    if (deferred) state.nextRunAt = firstSlot.toISOString();
    saveState(state);
    log.info(`📣 Catchup started — ${cohort.length} member(s), delayed until ${delayUntil}${deferred ? `, first message ${firstSlot.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}`);

    const when = fmt => firstSlot.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...fmt });
    if (deferred) {
      scheduleIn(firstSlot.getTime() - Date.now());
    } else {
      // Fire stage 0 in the background so the command reply is instant.
      runStage().catch(err => log.error(`❌ Catchup stage 0 failed: ${err.message}`));
    }

    return `📣 Catch-up armed for ${cohort.length} member(s).\n` +
      `⏸️ All delayed until ${delayUntil} — billing dates unchanged.\n` +
      `   They are ALREADY hidden from the daily overdue message, the final reminder\n` +
      `   and the removal list, starting immediately.\n\n` +
      `  ${deferred ? when({ weekday: 'short', hour: 'numeric', hour12: true }) : 'Now'}  → ${STAGES[0].label}\n` +
      `  +1 day  → ${STAGES[1].label}\n` +
      `  +2 days → ${STAGES[2].label}\n\n` +
      `Anyone who pays drops out automatically.\nCheck progress: catchup status`;
  }

  async function runStage() {
    if (_running) { log.warn('📣 Catchup stage skipped — already running'); return; }
    const state = loadState();
    if (!state) return;
    if (state.stage >= STAGES.length) { finish(state); return; }

    _running = true;
    try {
      const g = groupCfg();
      const stage = STAGES[state.stage];
      const sock = getSock();
      if (!sock?.user) {
        log.warn('⚠️  Catchup: socket not ready — retrying in 10 min');
        scheduleIn(10 * 60 * 1000);
        return;
      }

      await store.refresh();
      const members = stillUnpaid(state);

      if (members.length === 0) {
        log.info(`📣 Catchup stage ${state.stage + 1} (${stage.label}) — everyone paid, skipping`);
        state.log.push({ stage: stage.key, at: new Date().toISOString(), tagged: 0, note: 'all paid' });
        advance(state);
        return;
      }

      let participants = [];
      try {
        const meta = await sock.groupMetadata(g.groupId);
        participants = meta?.participants || [];
      } catch (err) {
        log.warn(`⚠️  Catchup groupMetadata failed: ${err.message} — sending without tags`);
      }

      // One message per billing date, spaced. sentBatches survives a restart mid-stage, so a
      // crash after batch 3 of 8 resumes at batch 4 — nobody is tagged twice.
      const batches = batchByBillingDate(members);
      state.sentBatches = state.sentBatches || [];
      const todo = batches.filter(b => !state.sentBatches.includes(b.key));
      let tagged = 0;

      for (let i = 0; i < todo.length; i++) {
        const batch = todo[i];
        const live = getSock();
        if (!live?.user) {
          log.warn(`⚠️  Catchup: socket lost after ${i}/${todo.length} batches — retrying in 10 min`);
          saveState(state);
          scheduleIn(10 * 60 * 1000);
          return;
        }

        const label = `${friendlyDate(batch.date)}${batch.part ? ` (part ${batch.part})` : ''}`;
        const { text, mentions } = buildGroupDigest({
          header: headerFor(stage, batch.date),
          members: batch.members,
          participants,
        });

        try {
          const qrPath = stage.withQr && config.upiQrPath
            ? path.resolve(config.botDir, config.upiQrPath) : null;
          if (qrPath && fs.existsSync(qrPath)) {
            await live.sendMessage(g.groupId, { image: fs.readFileSync(qrPath), caption: text, mentions });
          } else {
            await live.sendMessage(g.groupId, { text, mentions });
          }
          state.sentBatches.push(batch.key);
          tagged += batch.members.length;
          saveState(state);
          log.info(`📨 Catchup stage ${state.stage + 1}/${STAGES.length} (${stage.label}) — ${label}: ${batch.members.length} tagged  [${i + 1}/${todo.length}]`);
        } catch (err) {
          log.error(`❌ Catchup batch ${label} failed: ${err.message} — retrying stage in 30 min`);
          saveState(state);
          scheduleIn(30 * 60 * 1000);
          return;
        }

        if (i < todo.length - 1) {
          const gap = batchGapMs();
          log.info(`⏳ Next catch-up batch in ${(gap / 60000).toFixed(1)} min`);
          await sleep(gap);
        }
      }

      state.log.push({
        stage: stage.key, at: new Date().toISOString(),
        tagged, batches: batches.length,
      });
      advance(state);
    } finally {
      _running = false;
    }
  }

  function advance(state) {
    state.stage += 1;
    state.sentBatches = [];   // per-stage; the next stage re-batches from the live sheet
    if (state.stage >= STAGES.length) { finish(state); return; }
    // ~24h later, jittered, so three consecutive days never land at the same clock time.
    // With a startHour the jitter is one-sided (never earlier), so a 9 AM cycle can drift
    // to 10:30 but never back into the small hours.
    const ms = state.startHour !== null && state.startHour !== undefined
      ? DAY_MS + randomBetween(0, 90 * 60000)
      : DAY_MS + randomBetween(-90 * 60000, 90 * 60000);
    // Persisted so a restart resumes at the real slot instead of firing the next stage
    // early — three group messages in one afternoon is exactly what this avoids.
    state.nextRunAt = new Date(Date.now() + ms).toISOString();
    saveState(state);
    scheduleIn(ms);
  }

  function finish(state) {
    clearTimer();
    deleteState();
    const total = state.log.reduce((n, s) => Math.max(n, s.tagged), 0);
    log.info(`✅ Catchup complete — ${STAGES.length} stages, peak ${total} member(s) tagged`);
  }

  function scheduleIn(ms) {
    clearTimer();
    _timeout = setTimeout(() => {
      runStage().catch(err => log.error(`❌ Catchup stage failed: ${err.message}`));
    }, Math.max(ms, 1000));
    log.info(`⏳ Next catch-up stage in ${(ms / 3600000).toFixed(1)}h`);
  }

  function status() {
    const state = loadState();
    if (!state) return 'ℹ️ No catch-up cycle running. Start one with: catchup [days]';

    const done = state.log.map(s => {
      const stage = STAGES.find(x => x.key === s.stage);
      return `  ✅ ${stage?.label || s.stage} — ${s.tagged} tagged${s.note ? ` (${s.note})` : ''}`;
    });
    const remaining = STAGES.slice(state.stage).map(s => `  ⏳ ${s.label} — pending`);
    const left = state.stage < STAGES.length ? stillUnpaid(state).length : 0;
    const paid = state.cohort.length - left;

    return `📣 CATCH-UP IN PROGRESS\n\n` +
      `Started: ${new Date(state.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
      `Cohort: ${state.cohort.length} member(s) · ${paid} paid since · ${left} still unpaid\n` +
      `Delayed until: ${state.delayUntil}\n\n` +
      `${[...done, ...remaining].join('\n')}\n\n` +
      `Cancel with: stop catchup`;
  }

  function stop() {
    const state = loadState();
    clearTimer();
    if (!state) return 'ℹ️ No catch-up cycle running.';
    deleteState();
    log.info('🛑 Catchup cancelled by operator');
    return `🛑 Catch-up cancelled at stage ${state.stage + 1}/${STAGES.length}.\n` +
      `Members stay delayed until ${state.delayUntil} — clear early with: delay [phone] 0`;
  }

  // Called on every reconnect. An overdue stage (process was down past its slot) runs
  // shortly after reconnect rather than immediately, so a restart never coincides with a send.
  function resume() {
    const state = loadState();
    if (!state) return;
    if (state.stage >= STAGES.length) { finish(state); return; }
    const due = state.nextRunAt ? new Date(state.nextRunAt).getTime() : 0;
    const wait = due > Date.now()
      ? due - Date.now()                        // slot still ahead — keep the original time
      : randomBetween(5 * 60000, 15 * 60000);   // slot passed while down — run shortly
    log.info(`📣 Catchup resumed at stage ${state.stage + 1}/${STAGES.length}`);
    scheduleIn(wait);
  }

  return { preview, start, status, stop, resume, runStage, STAGES, GRACE_DAYS };
}
