import { daysFromToday, sleep, randomBetween, normalizePhone, isDelayActive, friendlyDate } from './globalConfig.js';

export function createOverdueEngine(config, log) {

  async function runOverdueCheck(store, getSock, broadcastJids) {
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

    // Day 7 exactly → final reminder to the member. This is their removal day (bulk removal
    // runs in the evening), so it's the last nudge before they're taken out. Skip delayed.
    const removalDay = config.overdue.consolidatedListDays;
    const finalDay = active.filter(m => {
      const d = daysFromToday(m.billingDate);
      return d !== null && d === -removalDay && !isDelayActive(m);
    });

    // Day 7+ → send consolidated list to owner
    const day7plus = active
      .filter(m => {
        const d = daysFromToday(m.billingDate);
        // Skip members with an active delay — they're hidden from the removal list until it expires.
        return d !== null && d <= -(config.overdue.consolidatedListDays) && !isDelayActive(m);
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    log.info(`⚠️  Overdue check: ${day6.length} at day-${config.overdue.autoReminderDays}, ${finalDay.length} at day-${removalDay} (final), ${day7plus.length} at day-7+`);

    // Send day-7 FINAL reminders directly to members (last day before removal)
    const finalTemplate = config.messages.finalReminder || config.messages.overdue;
    for (let i = 0; i < finalDay.length; i++) {
      const m = finalDay[i];
      const jid = `91${normalizePhone(m.phone)}@s.whatsapp.net`;
      const text = finalTemplate
        .replace('{name}', m.name)
        .replace('{days}', String(removalDay))
        .replace('{date}', friendlyDate());

      try {
        await sock.sendMessage(jid, { text });
        log.info(`📨 Day-${removalDay} FINAL reminder → ${m.name} (${m.phone})`);
      } catch (err) {
        log.warn(`❌ Final reminder failed [${m.name}]: ${err.message}`);
      }

      if (i < finalDay.length - 1) {
        await sleep(randomBetween(
          config.rateLimits.memberToMemberGapMinMs,
          config.rateLimits.memberToMemberGapMaxMs
        ));
      }
    }

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

    // Send consolidated list to all broadcast JIDs
    if (day7plus.length > 0) {
      const listLines = day7plus
        .map((m, i) => `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue`)
        .join('\n');

      const msg = config.messages.overdueConsolidated
        .replace('{count}', day7plus.length)
        .replace('{list}', listLines);

      const jids = Array.isArray(broadcastJids) ? broadcastJids : [broadcastJids];
      for (const jid of jids) {
        try {
          await sock.sendMessage(jid, { text: msg });
          log.info(`📋 Overdue list sent to ${jid} — ${day7plus.length} members`);
        } catch (err) {
          log.warn(`❌ Failed to send overdue list to ${jid}: ${err.message}`);
        }
      }
    }
  }

  return { runOverdueCheck };
}
