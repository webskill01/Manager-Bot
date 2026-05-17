import { daysFromToday, sleep, randomBetween, normalizePhone } from './globalConfig.js';

export function createOverdueEngine(config, log) {

  async function runOverdueCheck(store, getSock, ownerJid) {
    const sock = getSock();
    if (!sock?.user) {
      log.warn('⚠️  Overdue check skipped — socket not ready');
      return;
    }

    const active = store.getActive();

    // Day 6 exactly → auto-send reminder to member
    const day6 = active.filter(m => {
      const d = daysFromToday(m.billingDate);
      return d !== null && d === -config.overdue.autoReminderDays;
    });

    // Day 7+ → send consolidated list to owner
    const day7plus = active
      .filter(m => {
        const d = daysFromToday(m.billingDate);
        return d !== null && d <= -(config.overdue.consolidatedListDays);
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    log.info(`⚠️  Overdue check: ${day6.length} at day-6, ${day7plus.length} at day-7+`);

    // Send day-6 reminders directly to members
    for (let i = 0; i < day6.length; i++) {
      const m = day6[i];
      const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
      const text = config.messages.overdue
        .replace('{name}', m.name)
        .replace('{days}', config.overdue.autoReminderDays);

      try {
        await sock.sendMessage(jid, { text });
        log.info(`📨 Day-6 overdue reminder → ${m.name} (${m.phone})`);
      } catch (err) {
        log.warn(`❌ Day-6 reminder failed [${m.name}]: ${err.message}`);
      }

      if (i < day6.length - 1) {
        await sleep(randomBetween(
          config.rateLimits.memberToMemberGapMinMs,
          config.rateLimits.memberToMemberGapMaxMs
        ));
      }
    }

    // Send consolidated list to owner
    if (day7plus.length > 0) {
      const listLines = day7plus
        .map((m, i) => `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue`)
        .join('\n');

      const msg = config.messages.overdueConsolidated
        .replace('{count}', day7plus.length)
        .replace('{list}', listLines);

      try {
        await sock.sendMessage(ownerJid, { text: msg });
        log.info(`📋 Overdue list sent to owner — ${day7plus.length} members`);
      } catch (err) {
        log.warn(`❌ Failed to send overdue list to owner: ${err.message}`);
      }
    }
  }

  return { runOverdueCheck };
}
