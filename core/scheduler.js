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

  // morning-digest and evening-summary were removed deliberately (2026-07-27): both DM'd
  // every admin twice a day, and that was the traffic that got freshly linked numbers
  // banned — a brand-new account whose first-ever action is a 6 AM text blast to three
  // non-contacts. The same reports are now the `digest` and `summary` commands, so the
  // information is pulled on demand instead of pushed. Do NOT reintroduce them as crons.
  // The schedule.morningDigest / schedule.eveningSummary config keys are now inert.
  function start(tasks) {
    register(schedule.reminderSend,   'reminder-send',    tasks.reminderSend);
    register(schedule.reminderSend2,  'reminder-send-2',  tasks.reminderSend2);
    register(schedule.overdueCheck,   'overdue-check',    tasks.overdueCheck);
    log.info(`⏰ Scheduler started — ${jobs.length} jobs active`);
  }

  function stop() {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('⏰ Scheduler stopped');
  }

  return { start, stop };
}
