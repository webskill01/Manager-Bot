import fs from 'fs';
import path from 'path';
import { daysFromToday, normalizePhone as normPhone, getReferralsInBillingPeriod } from './globalConfig.js';
import { createMemberHandlers } from './handlers/memberHandlers.js';
import { createRenewalHandlers } from './handlers/renewalHandlers.js';
import { createLookupHandlers } from './handlers/lookupHandlers.js';
import { createReportHandlers } from './handlers/reportHandlers.js';

let activeOverdueList = [];

// Merge consecutive phone-part tokens at the start of args into one token.
// Phone parts: starts with + followed by digits, OR 3+ digit string.
// All other args (billing day 1-31, amount 45) are max 2 digits — no collision.
// Example: ['+91', '70158', '26065', '17'] → ['917015826065', '17']
// Example: ['91151', '18954', '17']        → ['9115118954', '17']
function mergePhoneFromStart(args) {
  if (args.length < 2) return args;
  const phoneParts = [];
  let i = 0;
  while (i < args.length && (/^\+\d+$/.test(args[i]) || /^\d{3,}$/.test(args[i]))) {
    phoneParts.push(args[i].replace(/\D/g, ''));
    i++;
  }
  if (phoneParts.length < 2) return args;
  return [phoneParts.join(''), ...args.slice(i)];
}

export function createCommandParser(store, groupManager, config, log, sock, botStartTime, trialEngine, removalEngine) {
  const memberH = createMemberHandlers(store, groupManager, config, log);
  const renewalH = createRenewalHandlers(store, config, log);
  const lookupH = createLookupHandlers(store, config, log);
  const reportH = createReportHandlers(store, config, botStartTime, log);

  function isOverdueAction(text) {
    return /^([RSW]\d+\s*)+$/i.test(text.trim());
  }

  async function handleOverdueActions(text) {
    const actions = text.trim().toUpperCase().match(/[RSW]\d+/g) || [];
    if (activeOverdueList.length === 0) return '❌ No active overdue list. Send "overdue" first.';

    const results = [];
    for (const action of actions) {
      const type = action[0];
      const idx = parseInt(action.slice(1), 10) - 1;
      if (idx < 0 || idx >= activeOverdueList.length) {
        results.push(`❌ ${action}: invalid number`);
        continue;
      }
      const member = activeOverdueList[idx];
      if (type === 'R') {
        const reply = await memberH.handleKick([member.phone]);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'S') {
        const reply = await memberH.handleSkip([member.phone, 'overdue-skipped']);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'W') {
        const msg = config.messages.overdue
          .replace('{name}', member.name)
          .replace('{days}', String(member.daysOverdue || 0));
        try {
          await sock.sendMessage(`91${member.phone}@s.whatsapp.net`, { text: msg });
          results.push(`${action}: ⚠️ Warning sent to ${member.name}`);
        } catch (err) {
          results.push(`${action}: ❌ Failed to send warning — ${err.message}`);
        }
      }
    }
    return results.join('\n');
  }

  async function parse(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (isOverdueAction(trimmed)) {
      return handleOverdueActions(trimmed);
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Pattern: "[phone] ref [refPhone]" — handles both compact and spaced formats:
    // "9876543210 ref 9876543211"  or  "+91 98765 43210 ref +91 98765 43211"
    const refPos = parts.findIndex(p => p.toLowerCase() === 'ref');
    const isPhonePart = p => /^\+\d+$/.test(p) || /^\d{3,}$/.test(p);
    if (refPos > 0 && refPos < parts.length - 1 && parts.slice(0, refPos).every(isPhonePart)) {
      const memberPhone = parts.slice(0, refPos).map(p => p.replace(/\D/g, '')).join('');
      const referrerPhone = parts.slice(refPos + 1).map(p => p.replace(/\D/g, '')).join('');
      try { return await memberH.handleRef([memberPhone, 'ref', referrerPhone]); }
      catch (err) {
        log.error(`❌ Handler error for ref command: ${err.message}`);
        return `❌ Error processing command: ${err.message}`;
      }
    }

    try {
      switch (cmd) {
        case 'add':        return memberH.handleAdd(args);
        case 'addsilent':  return memberH.handleSilentAdd(args);
        case 'kick':       return memberH.handleKick(mergePhoneFromStart(args));
        case 'skip':       return memberH.handleSkip(mergePhoneFromStart(args));
        case 'unskip':     return memberH.handleUnskip(mergePhoneFromStart(args));
        case 'approve':
        case 'approveall':
          if (args.length > 0) return '❌ Phone-specific approve is not supported — it never was.\nJust send "approve" (no number) to approve all pending join requests across all groups.';
          return memberH.handleApproveAll();
        case 'rejectall':  return memberH.handleRejectAll();
        case 'links':      return memberH.handleLinks(mergePhoneFromStart(args));
        case 'sendlinks':  return memberH.handleSendLinks(mergePhoneFromStart(args));
        case 'rejoin':     return memberH.handleRejoin(mergePhoneFromStart(args));
        case 'groupcheck': return memberH.handleGroupCheck(mergePhoneFromStart(args));

        case 'renewed':    return renewalH.handleRenewed(mergePhoneFromStart(args));
        case 'due':        return renewalH.handleDue(args);
        case 'overdue': {
          const result = renewalH.handleOverdue();
          activeOverdueList = store.getActive()
            .filter(m => daysFromToday(m.billingDate) !== null && daysFromToday(m.billingDate) < 0)
            .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
            .sort((a, b) => b.daysOverdue - a.daysOverdue);
          return result;
        }
        case 'pending':    return renewalH.handlePending();

        case 'refs':       return memberH.handleRefs(mergePhoneFromStart(args));

        case 'find':       return lookupH.handleFind(args);
        case 'status':     return lookupH.handleStatus(mergePhoneFromStart(args));

        case 'summary':    return reportH.handleSummary(args);
        case 'stats':      return reportH.handleStats();
        case 'revenue':    return reportH.handleRevenue();
        case 'groups':     return reportH.handleGroups();
        case 'removed':    return reportH.handleRemovedList();
        case 'skipped':    return reportH.handleSkippedList();
        case 'ping':       return reportH.handlePing(sock);
        case 'help':       return reportH.handleHelp();

        case 'upcoming':   return reportH.handleUpcoming(args);
        case 'toprefs':    return reportH.handleTopRefs();
        case 'loyal':      return reportH.handleLoyal(args);
        case 'growth':     return reportH.handleGrowth();
        case 'forecast':   return reportH.handleForecast();
        case 'trend':      return reportH.handleTrend();
        case 'churn':      return reportH.handleChurn();
        case 'norenew':    return reportH.handleNoRenew();
        case 'collection': return reportH.handleCollection();
        case 'tenure':     return reportH.handleTenure();
        case 'weekly':     return reportH.handleWeekly();
        case 'monthly':    return reportH.handleMonthly(args);
        case 'audit':      return reportH.handleAudit();

        case 'remind': {
          const phone = normPhone(mergePhoneFromStart(args)[0] || '');
          if (phone.length !== 10) return '❌ Format: remind [phone]';
          const member = store.findByPhone(phone);
          if (!member) return `❌ No member found for ${args[0] || phone}. Try: find [name]`;
          if (member.status !== 'ACTIVE') return `⚠️ ${member.name} is ${member.status} — remind only works for ACTIVE members.`;
          const all = store.getAll();
          const refs = getReferralsInBillingPeriod(member.phone, member.billingDate, all).length;
          if (refs >= 2) return `ℹ️ ${member.name} has ${refs} refs — they'll be auto-renewed, no reminder needed.`;
          const type = refs === 1 ? 'referral' : 'normal';
          const template = (type === 'referral' && config.messages.referralReminder)
            ? config.messages.referralReminder : config.messages.reminder;
          const caption = template.replace('{name}', member.name);
          const jid = `91${member.phone}@s.whatsapp.net`;
          try {
            const qrPath = config.upiQrPath ? path.resolve(config.botDir, config.upiQrPath) : null;
            if (qrPath && fs.existsSync(qrPath)) {
              const image = fs.readFileSync(qrPath);
              await sock.sendMessage(jid, { image, caption });
            } else {
              await sock.sendMessage(jid, { text: caption });
            }
            const amount = refs === 1 ? config.renewal.referralAmount : config.renewal.fullAmount;
            return `✅ Reminder sent to ${member.name} (${member.phone}) — ₹${amount}`;
          } catch (err) {
            return `❌ Failed to send reminder: ${err.message}`;
          }
        }

        case 'removal':    return removalEngine.handleRemoval();
        case 'warnall':    return removalEngine.warnall();
        case 'kickall':    return removalEngine.kickall();

        case 'start':
          if (args[0]?.toLowerCase() === 'removal') return trialEngine.start();
          return `❓ Unknown command. Did you mean "start removal"?`;
        case 'stop':
          if (args[0]?.toLowerCase() === 'removal') return trialEngine.stopCommand();
          if (args[0]?.toLowerCase() === 'kickall') return removalEngine.stopKickall();
          return `❓ Unknown command. Did you mean "stop removal" or "stop kickall"?`;

        default:
          return `❓ Unknown command: "${cmd}". Send 'help' for full list.`;
      }
    } catch (err) {
      log.error(`❌ Handler error for cmd "${cmd}": ${err.message}`);
      return `❌ Error processing command: ${err.message}`;
    }
  }

  function setOverdueList(list) {
    activeOverdueList = list;
  }

  return { parse, setOverdueList };
}
