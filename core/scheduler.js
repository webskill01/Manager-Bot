import cron from 'node-cron';

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
      log.info(`⏰ Running: ${label}`);
      try { await fn(); }
      catch (err) { log.error(`❌ Scheduled job [${label}]: ${err.message}`); }
    }, { timezone: tz });
    jobs.push(job);
    log.info(`⏰ Scheduled ${label} @ ${expr} (${tz})`);
  }

  function start(tasks) {
    register(schedule.morningDigest,  'morning-digest',   tasks.morningDigest);
    register(schedule.reminderSend,   'reminder-send',    tasks.reminderSend);
    register(schedule.reminderSend2,  'reminder-send-2',  tasks.reminderSend2);
    register(schedule.overdueCheck,   'overdue-check',    tasks.overdueCheck);
    register(schedule.eveningSummary, 'evening-summary',  tasks.eveningSummary);
    log.info(`⏰ Scheduler started — ${jobs.length} jobs active`);
  }

  function stop() {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('⏰ Scheduler stopped');
  }

  return { start, stop };
}
