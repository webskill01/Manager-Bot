import { normalizePhone, formatDate, todayStr, parseDate, getReferralsInBillingPeriod } from '../globalConfig.js';

export function createMemberHandlers(store, groupManager, config, log) {
  const inFlightAdds = new Set();

  async function handleAdd(args) {
    if (args.length < 2) return '❌ Format: add [name] [phone]  or  add [name] [phone] [date 1-31]';

    const mutableArgs = [...args];

    // Extract optional "ref <refPhone>" suffix before any other parsing
    let referrerPhone = null;
    const refIdx = mutableArgs.findIndex(a => a.toLowerCase() === 'ref');
    if (refIdx !== -1) {
      const refParts = mutableArgs.splice(refIdx); // removes 'ref' and everything after
      refParts.shift(); // drop 'ref' keyword
      if (refParts.length > 0) {
        const refNorm = normalizePhone(refParts.map(p => p.replace(/\D/g, '')).join(''));
        if (refNorm.length === 10) referrerPhone = refNorm;
      }
    }

    // Pop optional billing day (1-2 digits, 1–31) from end
    let billingDay = null;
    const maybeDate = mutableArgs[mutableArgs.length - 1];
    if (/^\d{1,2}$/.test(maybeDate) && parseInt(maybeDate) >= 1 && parseInt(maybeDate) <= 31) {
      billingDay = parseInt(mutableArgs.pop());
    }

    // Extract phone from the right: collect consecutive phone-part tokens
    // (3+ digits, or starts with + followed by digits). Stops when it hits a name token.
    // Leaves at least 1 token in mutableArgs for the name.
    const phoneParts = [];
    while (mutableArgs.length > 1) {
      const last = mutableArgs[mutableArgs.length - 1];
      if (/^\+\d+$/.test(last) || /^\d{3,}$/.test(last)) {
        phoneParts.unshift(last.replace(/\D/g, ''));
        mutableArgs.pop();
      } else {
        break;
      }
    }

    if (phoneParts.length === 0) return '❌ Format: add [name] [phone]  or  add [name] [phone] [date 1-31]';

    const phone = normalizePhone(phoneParts.join(''));
    if (phone.length !== 10) return '❌ Invalid number. Format: add Name 98551XXXXX';
    const name = mutableArgs.join(' ').trim();
    if (name.length < 2) return '❌ Name too short. Format: add Name 98551XXXXX';

    if (inFlightAdds.has(phone)) {
      return `⏳ Add for ${phone} already in progress — wait for it to finish.`;
    }

    const existing = store.findByPhone(phone);
    if (existing && existing.status === 'ACTIVE') {
      return `⚠️ ${existing.name} (${phone}) already ACTIVE. Use 'renewed' to update billing.`;
    }
    if (existing && existing.status === 'REMOVED') {
      return `⚠️ ${existing.name} (${phone}) was previously removed. Use: rejoin ${phone}`;
    }

    inFlightAdds.add(phone);
    try {
      const now = new Date();
      const day = billingDay ?? now.getDate();
      const billingDate = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, day));

      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        paidLast: config.joining.fee,
        reference: referrerPhone || '',
      });

      // Build referrer note (computed after add so store cache includes new member)
      let refNote = '';
      if (referrerPhone) {
        const referrer = store.findByPhone(referrerPhone);
        if (referrer) {
          const refs = getReferralsInBillingPeriod(referrerPhone, referrer.billingDate, store.getAll()).length;
          const refTag = refs >= 2 ? `🎁 ${refs} refs this month — free renewal`
            : refs === 1 ? `★ 1 ref this month — ₹45` : '0 refs';
          refNote = `\n👥 Referrer: ${referrer.name} — ${refTag}`;
        } else {
          refNote = `\n⚠️ Referrer ${referrerPhone} not found in sheet.`;
        }
      }

      // Build the message sequence from config: group links + welcome message
      const groupLinks = config.groupLinks || [];
      const welcome = config.welcomeMessage
        ? config.welcomeMessage.replace(/\{name\}/g, name)
        : null;
      const messages = welcome ? [...groupLinks, welcome] : [...groupLinks];

      if (messages.length === 0) {
        return `✅ ${name} added to sheet.\n📅 Billing: ${billingDate}${refNote}\n⚠️ No groupLinks configured — add them to config.json`;
      }

      const { sent, failed } = await groupManager.sendToMember(phone, messages);

      let reply = `✅ ${name} added to sheet.\n📅 Billing: ${billingDate}${refNote}\n`;
      reply += `📨 Sent ${sent}/${messages.length} messages to ${phone}`;
      if (failed > 0) reply += ` (${failed} failed — check if number is on WhatsApp)`;
      reply += `\n\nWhen they join, use:\napprove  (approves all pending across all groups)`;
      return reply;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  async function handleSilentAdd(args) {
    if (args.length < 2) return '❌ Format: addsilent [Name] [phone]  or  addsilent [Name] [phone] [day 1-31]';

    const mutableArgs = [...args];

    // Pop optional billing day (1-2 digits, 1–31) from end
    let billingDay = null;
    const maybeDate = mutableArgs[mutableArgs.length - 1];
    if (/^\d{1,2}$/.test(maybeDate) && parseInt(maybeDate) >= 1 && parseInt(maybeDate) <= 31) {
      billingDay = parseInt(mutableArgs.pop());
    }

    // Extract phone from the right
    const phoneParts = [];
    while (mutableArgs.length > 1) {
      const last = mutableArgs[mutableArgs.length - 1];
      if (/^\+\d+$/.test(last) || /^\d{3,}$/.test(last)) {
        phoneParts.unshift(last.replace(/\D/g, ''));
        mutableArgs.pop();
      } else {
        break;
      }
    }

    if (phoneParts.length === 0) return '❌ Format: addsilent [Name] [phone]';
    const phone = normalizePhone(phoneParts.join(''));
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits.';
    const name = mutableArgs.join(' ').trim();
    if (name.length < 2) return '❌ Name too short.';

    if (inFlightAdds.has(phone)) return `⏳ Operation for ${phone} already in progress.`;

    const existing = store.findByPhone(phone);
    if (existing) {
      if (existing.status === 'ACTIVE') return `⚠️ ${existing.name} (${phone}) already ACTIVE.`;
      if (existing.status === 'REMOVED') return `⚠️ ${existing.name} already in sheet as REMOVED. Use: rejoin ${phone}`;
      if (existing.status === 'SKIPPED') return `⚠️ ${existing.name} already SKIPPED. Use: unskip ${phone}`;
    }

    inFlightAdds.add(phone);
    try {
      const now = new Date();
      const day = billingDay ?? now.getDate();
      const billingDate = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, day));

      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        paidLast: config.joining.fee,
        reference: '',
      });

      log.info(`📋 Silent add: ${name} (${phone})`);
      return `✅ ${name} (${phone}) added to sheet (no links sent).\n📅 Billing: ${billingDate}\n\nNow use:\nrejoin ${phone}  →  adds directly to all groups`;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  async function handleKick(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: kick [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: kick 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status === 'REMOVED') return '⚠️ Already marked REMOVED. Not in any groups.';

    const result = await groupManager.removeFromAllGroups(phone);
    if (result.blocked) return result.blocked;
    const { removed, failed } = result;
    await store.update(phone, { status: 'REMOVED' });

    let reply = `✅ Removed ${member.name} from ${removed.length}/${config.paidGroups.length} groups`;
    if (failed.length > 0) {
      reply += `\n⚠️ Failed ${failed.length} groups — removed from sheet anyway.`;
    }
    return reply;
  }

  async function handleSkip(args) {
    if (args.length < 2) return '❌ Missing arguments. Format: skip [phone] [reason]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: skip 98551XXXXX reason';
    const reason = args.slice(1).join(' ');

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    await store.update(phone, { status: 'SKIPPED', skipReason: reason });
    return `✅ ${member.name} marked SKIPPED — won't appear in auto-remove list.\nReason: ${reason}`;
  }

  async function handleUnskip(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: unskip [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: unskip 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status !== 'SKIPPED') return `⚠️ ${member.name} is ${member.status}, not SKIPPED.`;

    await store.update(phone, { status: 'ACTIVE', skipReason: '' });
    return `✅ ${member.name} reverted to ACTIVE.`;
  }

  async function handleLinks(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: links [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const links = await groupManager.getInviteLinksForMissing(phone);
    if (links.length === 0) return `✅ ${member.name} is in all ${config.paidGroups.length} groups.`;

    const linkLines = links.map(l => `• ${l.groupName}\n  ${l.link}`).join('\n\n');
    return `🔗 Invite links for ${member.name} (missing from ${links.length} groups):\n\n${linkLines}`;
  }

  async function handleGroupCheck(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: groupcheck [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const { inGroups, notInGroups } = await groupManager.checkMembership(phone);
    let reply = `📋 ${member.name} (${phone}) group membership:\n`;
    reply += `✅ In ${inGroups.length} groups:\n${inGroups.map(g => `   • ${g}`).join('\n')}`;
    if (notInGroups.length > 0) {
      reply += `\n❌ Missing from ${notInGroups.length} groups:\n${notInGroups.map(g => `   • ${g}`).join('\n')}`;
    }
    return reply;
  }

  async function handleApproveAll() {
    const result = await groupManager.approveAllPendingRequests();
    if (result.alreadyRunning) return '⏳ Approve already in progress — wait for it to finish before sending again.';

    const { approved, failed, totalApproved, totalGroups } = result;
    if (totalGroups === 0) return '✅ No pending join requests across any group.';

    let reply = `✅ Approved ${totalApproved} pending request(s) across ${approved.length} group(s):`;
    for (const { groupName, count } of approved) {
      reply += `\n   • ${groupName}: ${count} approved`;
    }
    if (failed.length > 0) {
      reply += `\n\n❌ Failed in ${failed.length} group(s):`;
      for (const { groupName, reason } of failed) {
        reply += `\n   • ${groupName}: ${reason}`;
      }
    }
    return reply;
  }

  async function handleRejectAll() {
    const { rejected, failed, totalRejected, totalGroups } = await groupManager.rejectAllPendingRequests();

    if (totalGroups === 0) return '✅ No pending join requests to reject.';

    let reply = `🚫 Rejected ${totalRejected} pending request(s) across ${rejected.length} group(s):`;
    for (const { groupName, count } of rejected) {
      reply += `\n   • ${groupName}: ${count} rejected`;
    }
    if (failed.length > 0) {
      reply += `\n\n❌ Failed in ${failed.length} group(s):`;
      for (const { groupName, reason } of failed) {
        reply += `\n   • ${groupName}: ${reason}`;
      }
    }
    return reply;
  }

  async function handleRejoin(args) {
    if (args.length < 1) return '❌ Format: rejoin [phone]  or  rejoin [phone] [date 1-31]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Format: rejoin 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ ${phone} not in sheet.\n\nIf this is a previous member not tracked by bot, add them first:\naddsilent [Name] ${phone}\nThen run: rejoin ${phone}`;
    if (member.status !== 'REMOVED') return `⚠️ ${member.name} is ${member.status}, not REMOVED. Use 'renewed' for billing update.`;

    if (inFlightAdds.has(phone)) return `⏳ Operation for ${phone} already in progress.`;

    let billingDay = null;
    if (args[1] && /^\d{1,2}$/.test(args[1]) && parseInt(args[1]) >= 1 && parseInt(args[1]) <= 31) {
      billingDay = parseInt(args[1]);
    }

    inFlightAdds.add(phone);
    try {
      const now = new Date();
      const day = billingDay ?? now.getDate();
      const billingDate = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, day));

      await store.update(phone, {
        status: 'ACTIVE',
        billingDate,
        joinDate: todayStr(),
        paidLast: config.joining.fee,
        skipReason: '',
      });
      log.info(`♻️  Rejoined ${member.name} (${phone})`);

      // Try direct group add first (bypasses cooldown since rejoin is a manual admin action)
      const addResult = await groupManager.rejoinAdd(phone, member.name);

      let reply = `✅ ${member.name} reactivated.\n📅 Billing: ${billingDate}\n`;

      const { added, failed: addFailed } = addResult;
      const alreadyIn = addFailed.filter(f => f.reason === 'already_member');
      const privacyBlocked = addFailed.filter(f => f.reason === 'privacy_restricted');
      const effectiveAdded = added.length + alreadyIn.length;

      reply += `👤 Direct add: ${effectiveAdded}/${config.paidGroups.length} groups`;
      if (alreadyIn.length > 0) reply += ` (${alreadyIn.length} already member)`;

      if (privacyBlocked.length > 0) {
        // Send invite links for groups where privacy blocked the direct add
        const inviteMsgs = privacyBlocked.filter(f => f.inviteLink).map(f => `${f.groupName}:\n${f.inviteLink}`);
        if (inviteMsgs.length > 0) {
          reply += `\n\n⚠️ Privacy restricted (${privacyBlocked.length} groups) — sending invite links...`;
          const { sent } = await groupManager.sendToMember(phone, inviteMsgs);
          reply += `\n📨 Sent ${sent} invite links to ${phone}`;
          reply += `\nWhen they join: approve`;
        }
      }

      // Send welcome message
      const welcome = config.welcomeMessage ? config.welcomeMessage.replace(/\{name\}/g, member.name) : null;
      if (welcome) await groupManager.sendToMember(phone, [welcome]);

      return reply;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  async function handleSendLinks(args) {
    if (args.length < 1) return '❌ Format: sendlinks [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    const groupLinks = config.groupLinks || [];
    const welcome = config.welcomeMessage
      ? config.welcomeMessage.replace(/\{name\}/g, member.name)
      : null;
    const messages = welcome ? [...groupLinks, welcome] : [...groupLinks];

    if (messages.length === 0) return '⚠️ No groupLinks configured in config.json';

    const { sent, failed } = await groupManager.sendToMember(phone, messages);
    let reply = `📨 Sent ${sent}/${messages.length} messages to ${member.name} (${phone})`;
    if (failed > 0) reply += `\n⚠️ ${failed} failed — check if number is on WhatsApp`;
    reply += `\n\nWhen they join, use:\napprove  (approves all pending across all groups)`;
    return reply;
  }

  async function handleRef(parts) {
    // parts: [memberPhone, 'ref', ...referrerPhoneParts]
    if (parts.length < 3) return '❌ Format: [phone] ref [refPhone]  Example: 9876543210 ref 6284001093';
    const phone = normalizePhone(parts[0]);
    if (phone.length !== 10) return '❌ Invalid member phone.';

    const refNorm = normalizePhone(parts.slice(2).map(p => p.replace(/\D/g, '')).join(''));
    if (refNorm.length !== 10) return '❌ Invalid referrer phone.';
    if (phone === refNorm) return '❌ Cannot set yourself as your own referrer.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${parts[0]}. Try: find [name]`;

    const referrer = store.findByPhone(refNorm);
    let warning = referrer ? '' : `\n⚠️ Referrer ${refNorm} not found in sheet — reference recorded anyway.`;

    await store.update(phone, { reference: refNorm });

    if (referrer) {
      const refs = getReferralsInBillingPeriod(refNorm, referrer.billingDate, store.getAll()).length;
      const refTag = refs >= 2 ? `🎁 ${refs} refs this month — free renewal`
        : refs === 1 ? `★ 1 ref this month — ₹45` : '0 refs this month';
      return `✅ ${member.name}'s referrer set to ${referrer.name} (${refNorm})\n${referrer.name}: ${refTag}`;
    }

    return `✅ ${member.name}'s referrer set to ${refNorm}${warning}`;
  }

  function handleRefs(args) {
    if (args.length < 1) return '❌ Format: refs [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    const all = store.getAll();
    const currentRefs = getReferralsInBillingPeriod(phone, member.billingDate, all);
    const allTimeRefs = all.filter(m => m.reference && normalizePhone(m.reference) === phone);

    const billingObj = parseDate(member.billingDate);
    let periodStart = '?';
    if (billingObj) {
      const d = new Date(billingObj);
      d.setMonth(d.getMonth() - 1);
      periodStart = formatDate(d);
    }

    let msg = `📊 Refs for ${member.name} (${phone})\n`;
    msg += `Billing period (${periodStart} → ${member.billingDate}):\n`;
    if (currentRefs.length > 0) {
      msg += currentRefs.map(m => `  • ${m.name}  ${m.phone}  Joined ${m.joinDate}`).join('\n') + '\n';
    }
    const countLine = currentRefs.length === 0
      ? `  Count: 0`
      : currentRefs.length >= 2
        ? `  Count: ${currentRefs.length} → 🎉 Free renewal on ${member.billingDate}`
        : `  Count: 1 → 💰 ₹45 on ${member.billingDate}`;
    msg += `${countLine}\n`;

    msg += `\nAll-time (${allTimeRefs.length} total):`;
    if (allTimeRefs.length > 0) {
      const sorted = [...allTimeRefs].sort((a, b) => {
        const da = parseDate(a.joinDate), db = parseDate(b.joinDate);
        return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
      });
      msg += '\n' + sorted.slice(0, 10).map(m => `  • ${m.name}  ${m.phone}  ${m.joinDate}`).join('\n');
      if (allTimeRefs.length > 10) msg += `\n  ... +${allTimeRefs.length - 10} more`;
    }

    return msg;
  }

  return { handleAdd, handleSilentAdd, handleKick, handleSkip, handleUnskip, handleLinks, handleGroupCheck, handleApproveAll, handleRejectAll, handleSendLinks, handleRejoin, handleRef, handleRefs };
}
