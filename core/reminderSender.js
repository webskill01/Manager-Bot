import fs from 'fs';
import path from 'path';
import { daysFromToday, sleep, randomBetween, normalizePhone } from './globalConfig.js';

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
    const text = config.messages.reminder.replace('{name}', name);

    try {
      await sock.sendMessage(jid, { text });
      log.info(`📨 Reminder sent: ${name} (${phone})`);

      const qrPath = path.resolve(botDir, config.upiQrPath);
      if (config.upiQrPath && fs.existsSync(qrPath)) {
        await sleep(randomBetween(2000, 4000));
        const image = fs.readFileSync(qrPath);
        await sock.sendMessage(jid, { image, caption: '₹90 is number pe bhejo 🙏' });
        log.info(`🖼️  QR image sent: ${name}`);
      }

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

  async function sendReminders(store, getSock, botDir) {
    const dueToday = store.getActive().filter(m => daysFromToday(m.billingDate) === 0);

    if (dueToday.length === 0) {
      log.info('⏰ Reminder: no members due today');
      return { sent: 0, failed: 0, queued: 0 };
    }

    log.info(`⏰ Reminder: ${dueToday.length} members due today`);

    const batch     = dueToday.slice(0, config.rateLimits.batchSize);
    const remainder = dueToday.slice(config.rateLimits.batchSize);

    let sent = 0, failed = 0;

    for (let i = 0; i < batch.length; i++) {
      const m = batch[i];
      if (await sendToMember(getSock, m.phone, m.name, botDir)) sent++; else failed++;

      if (i < batch.length - 1) {
        const gap = randomBetween(
          config.rateLimits.memberToMemberGapMinMs,
          config.rateLimits.memberToMemberGapMaxMs
        );
        log.info(`⏳ Next reminder in ${(gap / 1000).toFixed(1)}s`);
        await sleep(gap);
      }
    }

    if (remainder.length > 0) {
      log.info(`📋 ${remainder.length} reminders queued for +${config.rateLimits.secondBatchDelayMs / 3600000}h`);
      setTimeout(async () => {
        log.info(`⏰ Sending queued batch (${remainder.length} members)...`);
        for (let i = 0; i < remainder.length; i++) {
          await sendToMember(getSock, remainder[i].phone, remainder[i].name, botDir);
          if (i < remainder.length - 1) {
            await sleep(randomBetween(
              config.rateLimits.memberToMemberGapMinMs,
              config.rateLimits.memberToMemberGapMaxMs
            ));
          }
        }
      }, config.rateLimits.secondBatchDelayMs);
    }

    log.info(`⏰ Reminder batch done: ${sent} sent, ${failed} failed, ${remainder.length} queued`);
    return { sent, failed, queued: remainder.length };
  }

  return { sendReminders, sendToMember };
}
