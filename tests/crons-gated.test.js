import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { usesCloudApi } from '../core/cloudApiSender.js';

test('usesCloudApi is false until both configured and selected', () => {
  assert.equal(usesCloudApi({}), false);
  assert.equal(usesCloudApi({ reminderChannel: 'cloudapi' }), false, 'selected but unconfigured');
  assert.equal(usesCloudApi({
    reminderChannel: 'cloudapi',
    cloudApi: { phoneNumberId: '1', token: 't', templateName: 'x' },
  }), true);
});

test('index.js gates every reminder cron on usesCloudApi', () => {
  const src = fs.readFileSync(new URL('../core/index.js', import.meta.url), 'utf8');
  assert.ok(
    /import \{ usesCloudApi \} from '\.\/cloudApiSender\.js'/.test(src),
    'usesCloudApi must be imported',
  );
  // All three scheduled jobs must bail before sending when the channel is manual.
  const guards = src.match(/if \(!usesCloudApi\(config\)\) return log\.info/g) || [];
  assert.equal(guards.length, 3, `expected a guard in all 3 jobs, found ${guards.length}`);
});

test('no cron job can reach a Baileys reminder send while the channel is manual', () => {
  const src = fs.readFileSync(new URL('../core/index.js', import.meta.url), 'utf8');
  // Each job body must place its guard BEFORE the call that actually sends.
  for (const [job, sendCall] of [
    ['reminderSend', 'reminderSender.sendReminders('],
    ['reminderSend2', 'reminderSender.sendRemindersSecondBatch('],
    ['overdueCheck', 'overdueEngine.runOverdueCheck('],
  ]) {
    const start = src.indexOf(`${job}: async () =>`);
    assert.ok(start > -1, `${job} job not found`);
    const body = src.slice(start, src.indexOf(sendCall, start));
    assert.ok(
      body.includes('!usesCloudApi(config)'),
      `${job} must check usesCloudApi before calling ${sendCall}`,
    );
  }
});

// ── restored digest crons: absent task → absent job ────────────────────────────
import { createScheduler } from '../core/scheduler.js';

function countingLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(String(m)), warn: () => {}, error: () => {} };
}

const schedCfg = {
  schedule: {
    reminderSend: '30 6 * * *',
    reminderSend2: '30 7 * * *',
    overdueCheck: '0 10 * * *',
    morningDigest: '0 6 * * *',
    eveningSummary: '0 22 * * *',
    timezone: 'Asia/Kolkata',
    jitterMaxMinutes: 0,
  },
};

const jobCount = (log) =>
  Number(log.lines.find(l => l.includes('Scheduler started')).match(/(\d+) jobs active/)[1]);

const noop = () => {};

test('without Telegram tasks only the three renewal jobs register', () => {
  const log = countingLog();
  const s = createScheduler(schedCfg, log);
  s.start({ reminderSend: noop, reminderSend2: noop, overdueCheck: noop });
  assert.equal(jobCount(log), 3, 'a token-less bot must get no digest and no drip');
  s.stop();
});

test('with Telegram tasks the digests and the drip register too', () => {
  const log = countingLog();
  const s = createScheduler(schedCfg, log);
  s.start({
    reminderSend: noop, reminderSend2: noop, overdueCheck: noop,
    morningDigest: noop, eveningSummary: noop, dripArm: noop,
  });
  assert.equal(jobCount(log), 6);
  s.stop();
});

test('the drip arms at 9 AM by default when no cron is configured', () => {
  const log = countingLog();
  const s = createScheduler(schedCfg, log);
  s.start({ reminderSend: noop, reminderSend2: noop, overdueCheck: noop, dripArm: noop });
  assert.ok(log.lines.some(l => l.includes('drip-arm @ 0 9 * * *')));
  s.stop();
});
