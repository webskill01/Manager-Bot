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
