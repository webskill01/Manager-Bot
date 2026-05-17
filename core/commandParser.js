import { daysFromToday } from './globalConfig.js';
import { createMemberHandlers } from './handlers/memberHandlers.js';
import { createRenewalHandlers } from './handlers/renewalHandlers.js';
import { createLookupHandlers } from './handlers/lookupHandlers.js';
import { createReportHandlers } from './handlers/reportHandlers.js';

let activeOverdueList = [];

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

    try {
      switch (cmd) {
        case 'add':        return memberH.handleAdd(args);
        case 'kick':       return memberH.handleKick(args);
        case 'skip':       return memberH.handleSkip(args);
        case 'unskip':     return memberH.handleUnskip(args);
        case 'approve':    return memberH.handleApprove(args);
        case 'links':      return memberH.handleLinks(args);
        case 'groupcheck': return memberH.handleGroupCheck(args);

        case 'renewed':    return renewalH.handleRenewed(args);
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

        case 'find':       return lookupH.handleFind(args);
        case 'status':     return lookupH.handleStatus(args);

        case 'summary':    return reportH.handleSummary();
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
