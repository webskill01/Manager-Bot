import fs from 'fs';
import path from 'path';
import { randomBetween, todayStr, friendlyDate } from './globalConfig.js';
import { buildDmList } from './dmList.js';

// Paces the operator's MANUAL renewal DMs.
//
// The bot holds no socket here and sends nothing to any member. It pushes tap-to-send
// wa.me links to Telegram on a timer; the operator taps and the message goes from their own
// phone, as a normal human message. That is the entire safety argument — the July bans came
// from a linked device sending on a schedule, and nothing in this file can do that.
//
// It exists because the operator kept forgetting to run `dmlist` and then sent a whole day's
// reminders in one sitting, which is the worst possible shape. Forgetting was accidentally
// rate-limiting them; this replaces that accident with a deliberate, even cadence.

// Defaults sized against a 929-member sheet: ~31 members come due each day, and a 9 AM-9 PM
// window at an 18-25 min gap gives ~34 slots — enough headroom for a normal day. A range
// rather than a fixed gap plus jitter because a random range IS the jitter; two mechanisms
// where one does the job is just more to keep in sync.
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 21;
const DEFAULT_GAP_MIN_MS = 18 * 60 * 1000;
const DEFAULT_GAP_MAX_MS = 25 * 60 * 1000;

export function dripSettings(config) {
  const d = config.drip || {};
  return {
    startHour: d.startHour ?? DEFAULT_START_HOUR,
    endHour: d.endHour ?? DEFAULT_END_HOUR,
    gapMinMs: d.gapMinMs ?? DEFAULT_GAP_MIN_MS,
    gapMaxMs: d.gapMaxMs ?? DEFAULT_GAP_MAX_MS,
  };
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
export function buildDripBatch({ members, config, pushed = [], now = todayStr() }) {
  const seen = new Set(pushed.map(String));
  const batch = [];
  for (const cohort of ['due', 'nudge', 'final']) {
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

// `notify` is index.js's notifyTelegram, already bound to config.dripIds. The engine is never
// handed a socket — it cannot send over WhatsApp even by accident, which is why the operator
// is in the loop at all.
export function createDripEngine(config, log, store, reminderSender, notify) {
  const stateFile = path.join(config.botDir, 'drip-state.json');
  const settings = dripSettings(config);
  let _timer = null;

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

  function clearTimer() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  function scheduleNext() {
    clearTimer();
    const gap = randomBetween(settings.gapMinMs, settings.gapMaxMs);
    log.info(`💧 Next drip push in ${Math.round(gap / 60000)}m`);
    _timer = setTimeout(() => { tick().catch(err => log.error(`❌ Drip tick: ${err.message}`)); }, gap);
    if (_timer.unref) _timer.unref();
  }

  async function tick() {
    const state = loadState();
    if (state.stopped || state.done) return;

    if (!withinWindow(new Date(), settings)) return finish(state);

    await store.refresh();
    const members = store.getAll();
    const batch = buildDripBatch({ members, config, pushed: state.pushed });
    if (batch.length === 0) return finish(state);

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
    await notify(
      `💧 *Drip finished* — ${friendlyDate()}\n` +
      `${state.pushed.length} pushed` +
      (left > 0
        ? `, ${left} NOT reached today (they roll into tomorrow one day more overdue).`
        : `, nobody left. 👍`),
    );
    log.info(`💧 Drip finished — ${state.pushed.length} pushed, ${left} unreached`);
  }

  // Called by the 9 AM cron. Auto-renew runs ONCE per day here, not per tick: a 2-referral
  // member owes nothing, and chasing them for money is a real error, not a cosmetic one.
  async function arm() {
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
    const state = loadState();
    state.stopped = false;
    state.done = false;
    saveState(state);
    arm().catch(err => log.error(`❌ Drip start: ${err.message}`));
    return '💧 Drip started — first links coming shortly.';
  }

  function status() {
    const state = loadState();
    const s = state.stopped ? '🛑 stopped' : state.done ? '✅ finished' : '💧 running';
    return `${s} — ${state.pushed.length} pushed today (window ${settings.startHour}:00–${settings.endHour}:00)`;
  }

  // `drip test` — push ONE real batch right now and change nothing.
  //
  // Ignores the window, does not persist to state.pushed, does not schedule a next tick and
  // does not auto-renew. Without it, checking that the notifications work means waiting for
  // a 9 AM cron and then 20 minutes per push. Because it records nothing, the members it
  // shows still get their real push later — running it never costs anyone a reminder.
  async function test() {
    await store.refresh();
    const state = loadState();
    const members = store.getAll();
    const batch = buildDripBatch({ members, config, pushed: state.pushed });
    if (batch.length === 0) return '✅ Nothing to send right now — nobody due, overdue or final.';
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
    const state = loadState();
    if (state.stopped || state.done || !state.armedAt) return;
    if (!withinWindow(new Date(), settings)) return;
    log.info('💧 Resuming drip after restart');
    scheduleNext();
  }

  return { arm, start, stop, status, resume, tick, test };
}
