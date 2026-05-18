import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone, todayStr } from './globalConfig.js';

export function createReminderSender(config, log) {
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let circuitOpenAt = null;

  function checkCircuit() {
    if (!circuitOpen) return false;
    if (Date.now() - circuitOpenAt > config.rateLimits.circuitBreakerCooldownMs) {
      circuitOpen = false;
      consecutiveFailures = 0;
      log.info('⚡ Circuit breaker reset');
      return false;
    }
    return true;
  }

  function loadState(botDir) {
    const stateFile = path.join(botDir, 'reminder-state.json');
    try {
      if (fs.existsSync(stateFile)) {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (data.date === todayStr()) return data;
      }
    } catch {}
    return { date: todayStr(), sentPhones: [] };
  }

  function saveState(botDir, state) {
    const stateFile = path.join(botDir, 'reminder-state.json');
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, stateFile);
  }

  async function sendToMember(getSock, phone, name, botDir) {
    if (checkCircuit()) {
      log.warn(`⚡ Circuit open — skipping ${name}`);
      return false;
    }

    const sock = getSock();
    if (!sock?.user) {
      log.warn(`⚠️  Socket not ready — skipping ${name}`);
      return false;
    }

    const jid = `91${normalizePhone(phone)}@s.whatsapp.net`;
    const caption = config.messages.reminder.replace('{name}', name);

    try {
      const qrPath = path.resolve(botDir, config.upiQrPath);
      if (config.upiQrPath && fs.existsSync(qrPath)) {
        const image = fs.readFileSync(qrPath);
        await sock.sendMessage(jid, { image, caption });
      } else {
        await sock.sendMessage(jid, { text: caption });
      }
      log.info(`📨 Reminder sent: ${name} (${phone})`);
      consecutiveFailures = 0;
      return true;
    } catch (err) {
      consecutiveFailures++;
      log.warn(`❌ Reminder failed [${name}]: ${err.message}`);
      if (consecutiveFailures >= config.rateLimits.circuitBreakerThreshold) {
        circuitOpen = true;
        circuitOpenAt = Date.now();
        log.error(`⚡ Circuit breaker OPEN — ${consecutiveFailures} consecutive failures`);
      }
      return false;
    }
  }

  async function runBatch(members, getSock, botDir, state, label) {
    let sent = 0, failed = 0;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (await sendToMember(getSock, m.phone, m.name, botDir)) {
        sent++;
        state.sentPhones.push(m.phone);
        saveState(botDir, state);
      } else {
        failed++;
      }
      if (i < members.length - 1) {
        const gap = randomBetween(config.rateLimits.memberToMemberGapMinMs, config.rateLimits.memberToMemberGapMaxMs);
        log.info(`⏳ Next reminder in ${(gap / 1000).toFixed(1)}s`);
        await sleep(gap);
      }
    }
    log.info(`⏰ ${label} done: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }

  // Batch 1 (6:30 AM cron) — sends up to batchSize members, skips already-sent
  async function sendReminders(store, getSock, botDir) {
    const state = loadState(botDir);
    const dueToday = store.getActive().filter(m => daysFromToday(m.billingDate) === 0);

    if (dueToday.length === 0) {
      log.info('⏰ Reminder batch 1: no members due today');
      return { sent: 0, failed: 0, queued: 0 };
    }

    const pending = dueToday.filter(m => !state.sentPhones.includes(m.phone));
    if (pending.length === 0) {
      log.info('⏰ Reminder batch 1: all members already sent today');
      return { sent: 0, failed: 0, queued: 0 };
    }

    const batch = pending.slice(0, config.rateLimits.batchSize);
    const remainder = pending.slice(config.rateLimits.batchSize);

    log.info(`⏰ Reminder batch 1: ${batch.length} members (${state.sentPhones.length} already sent, ${remainder.length} held for batch 2)`);

    const result = await runBatch(batch, getSock, botDir, state, 'Reminder batch 1');
    if (remainder.length > 0) {
      log.info(`📋 ${remainder.length} members held for batch 2 at 7:30 AM`);
    }
    return { ...result, queued: remainder.length };
  }

  // Batch 2 (7:30 AM cron) — sends remaining members not yet sent today
  async function sendRemindersSecondBatch(store, getSock, botDir) {
    const state = loadState(botDir);
    const dueToday = store.getActive().filter(m => daysFromToday(m.billingDate) === 0);
    const remaining = dueToday.filter(m => !state.sentPhones.includes(m.phone));

    if (remaining.length === 0) {
      log.info('⏰ Reminder batch 2: nothing remaining');
      return { sent: 0, failed: 0 };
    }

    log.info(`⏰ Reminder batch 2: ${remaining.length} members`);
    return runBatch(remaining, getSock, botDir, state, 'Reminder batch 2');
  }

  return { sendReminders, sendRemindersSecondBatch, sendToMember };
}
