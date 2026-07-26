import fs from 'fs';
import path from 'path';
import {
  daysFromToday, formatDate, todayStr, randomBetween,
  overdueCohort, renewedOn,
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

  function headerFor(stage) {
    const m = config.messages || {};
    // groupFinal is optional — a bot that never configured it falls back to its
    // overdue wording rather than failing the last (most important) stage.
    const raw = m[stage.headerKey] || m.groupOverdue || '🚨 Renewal pending — please repay';
    return raw.replace('{date}', new Date().toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
    }));
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

    const lines = cohort.slice(0, 20)
      .map((m, i) => `${i + 1}. ${m.name} (${m.phone}) — ${Math.abs(daysFromToday(m.billingDate))}d overdue`);
    const more = cohort.length > 20 ? `\n…and ${cohort.length - 20} more` : '';

    return `📣 CATCHUP PREVIEW — ${cohort.length} member(s) missed while the bot was down\n\n` +
      `${lines.join('\n')}${more}\n\n` +
      `Plan (group messages only — no DMs):\n` +
      `  Today  → ${STAGES[0].label}${STAGES[0].withQr ? ' + QR' : ''}\n` +
      `  Day 2  → ${STAGES[1].label}\n` +
      `  Day 3  → ${STAGES[2].label}\n\n` +
      `All ${cohort.length} delayed ${GRACE_DAYS} days so nobody is removed mid-sequence.\n` +
      `Billing dates are NOT changed.\n\n` +
      `To start: catchup ${windowDays} confirm`;
  }

  async function start(windowDays) {
    if (!groupCfg()) {
      return '❌ catchup works in group reminder mode only — set reminder.mode to "group" and fill reminder.groupId in this bot\'s config.';
    }
    if (loadState()) return `⚠️ A catch-up cycle is already running.\n\n${status()}`;

    await store.refresh();
    const cohort = buildCohort(windowDays);
    if (cohort.length === 0) {
      return `✅ Nobody fell due in the last ${windowDays} days and is still unpaid — nothing to catch up on.`;
    }

    // Grace first, messages second — if the process dies between the two, members are
    // protected rather than exposed.
    const until = new Date();
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

    const state = {
      startedAt: new Date().toISOString(),
      windowDays,
      delayUntil,
      stage: 0,
      cohort: cohort.map(m => ({ name: m.name, phone: m.phone })),
      log: [],
    };
    saveState(state);
    log.info(`📣 Catchup started — ${cohort.length} member(s), delayed until ${delayUntil}`);

    // Fire stage 0 in the background so the command reply is instant.
    runStage().catch(err => log.error(`❌ Catchup stage 0 failed: ${err.message}`));

    return `📣 Catch-up started for ${cohort.length} member(s).\n` +
      `⏸️ All delayed until ${delayUntil} (billing dates unchanged).\n\n` +
      `  Today  → ${STAGES[0].label}  (sending now)\n` +
      `  Day 2  → ${STAGES[1].label}\n` +
      `  Day 3  → ${STAGES[2].label}\n\n` +
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

      const { text, mentions } = buildGroupDigest({
        header: headerFor(stage), members, participants,
      });

      try {
        const qrPath = stage.withQr && config.upiQrPath
          ? path.resolve(config.botDir, config.upiQrPath) : null;
        if (qrPath && fs.existsSync(qrPath)) {
          await sock.sendMessage(g.groupId, { image: fs.readFileSync(qrPath), caption: text, mentions });
        } else {
          await sock.sendMessage(g.groupId, { text, mentions });
        }
        log.info(`📨 Catchup stage ${state.stage + 1}/${STAGES.length} (${stage.label}) — ${members.length} tagged`);
        state.log.push({ stage: stage.key, at: new Date().toISOString(), tagged: members.length });
        advance(state);
      } catch (err) {
        log.error(`❌ Catchup stage ${state.stage + 1} send failed: ${err.message} — retrying in 30 min`);
        scheduleIn(30 * 60 * 1000);
      }
    } finally {
      _running = false;
    }
  }

  function advance(state) {
    state.stage += 1;
    if (state.stage >= STAGES.length) { finish(state); return; }
    // ~24h later, jittered, so three consecutive days never land at the same clock time.
    const ms = DAY_MS + randomBetween(-90 * 60000, 90 * 60000);
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
