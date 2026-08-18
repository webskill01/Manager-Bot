import cron from 'node-cron';
import { randomBetween, sleep } from './globalConfig.js';

// Random 0..maxMinutes delay applied before every scheduled job runs, so nothing
// fires at a predictable time. 0 disables jitter for a bot.
export function computeJitterMs(maxMinutes) {
  const max = Number(maxMinutes) || 0;
  if (max <= 0) return 0;
  return randomBetween(0, max * 60000);
}

export function createScheduler(config, log) {
  const { schedule } = config;
  const tz = schedule.timezone || 'Asia/Kolkata';
  const jobs = [];

  function register(expr, label, fn) {
    if (!expr) return;
    if (!cron.validate(expr)) {
      log.warn(`⏰ Invalid cron for ${label}: ${expr}`);
      return;
    }
    const job = cron.schedule(expr, async () => {
      const jitter = computeJitterMs(schedule.jitterMaxMinutes ?? 20);
      if (jitter > 0) {
        log.info(`⏰ ${label} jittered +${Math.floor(jitter / 60000)}m ${Math.round((jitter % 60000) / 1000)}s`);
        await sleep(jitter);
      }
      log.info(`⏰ Running: ${label}`);
      try { await fn(); }
      catch (err) { log.error(`❌ Scheduled job [${label}]: ${err.message}`); }
    }, { timezone: tz });
    jobs.push(job);
    log.info(`⏰ Scheduled ${label} @ ${expr} (${tz}, jitter ≤${schedule.jitterMaxMinutes ?? 20}m)`);
  }

  // morning-digest and evening-summary were removed in July 2026 because both DM'd every
  // admin twice a day over WhatsApp, and that was the traffic that got freshly linked
  // numbers banned — a brand-new account whose first-ever action is a 6 AM text blast to
  // three non-contacts.
  //
  // They are back, under the one condition that removes the cause entirely: index.js passes
  // these tasks ONLY when config.usesTelegram is true, and the tasks it passes deliver
  // through notifyTelegram — never broadcast(), which also writes to the WhatsApp socket.
  // So a bot with no Telegram token receives no digest task and registers no digest job.
  //
  // That is why the gate lives in the caller rather than here: this file cannot see how a
  // task delivers, and a `usesTelegram` check in this file would give the wrong answer for
  // any task that still reached WhatsApp. Absent task → absent job is the honest contract.
  // Do NOT add a WhatsApp delivery path to these.
  function start(tasks) {
    register(schedule.reminderSend,   'reminder-send',    tasks.reminderSend);
    register(schedule.reminderSend2,  'reminder-send-2',  tasks.reminderSend2);
    register(schedule.overdueCheck,   'overdue-check',    tasks.overdueCheck);
    if (tasks.morningDigest)  register(schedule.morningDigest,  'morning-digest',  tasks.morningDigest);
    if (tasks.eveningSummary) register(schedule.eveningSummary, 'evening-summary', tasks.eveningSummary);
    if (tasks.dripArm)        register(schedule.dripArm || '0 9 * * *', 'drip-arm', tasks.dripArm);
    log.info(`⏰ Scheduler started — ${jobs.length} jobs active`);
  }

  function stop() {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('⏰ Scheduler stopped');
  }

  return { start, stop };
}
