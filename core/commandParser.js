import { daysFromToday } from './globalConfig.js';
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

export function createCommandParser(store, groupManager, config, log, sock, botStartTime) {
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

    // Pattern: "[phone] ref [refPhone]" — update referrer on an existing member
    if (parts.length >= 3 && parts[1]?.toLowerCase() === 'ref' && /^\+?\d{10,13}$/.test(parts[0])) {
      try { return await memberH.handleRef(parts); }
      catch (err) {
        log.error(`❌ Handler error for ref command: ${err.message}`);
        return `❌ Error processing command: ${err.message}`;
      }
    }

    try {
      switch (cmd) {
        case 'add':        return memberH.handleAdd(args);
        case 'kick':       return memberH.handleKick(mergePhoneFromStart(args));
        case 'skip':       return memberH.handleSkip(mergePhoneFromStart(args));
        case 'unskip':     return memberH.handleUnskip(mergePhoneFromStart(args));
        case 'approve':    return memberH.handleApproveAll();
        case 'approveall': return memberH.handleApproveAll();
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
        case 'ping':       return reportH.handlePing(sock);
        case 'help':       return reportH.handleHelp();

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
