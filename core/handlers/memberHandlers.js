import { normalizePhone, formatDate, todayStr } from '../globalConfig.js';

export function createMemberHandlers(store, groupManager, config, log) {
  const inFlightAdds = new Set();

  async function handleAdd(args) {
    if (args.length < 2) return '❌ Format: add [name] [phone]  or  add [name] [phone] [date 1-31]';

    const mutableArgs = [...args];

    // Optional billing day: last arg if it's 1–2 digits and ≤ 31
    let billingDay = null;
    const maybeDate = mutableArgs[mutableArgs.length - 1];
    if (/^\d{1,2}$/.test(maybeDate) && parseInt(maybeDate) >= 1 && parseInt(maybeDate) <= 31) {
      billingDay = parseInt(mutableArgs.pop());
    }

    if (mutableArgs.length < 2) return '❌ Format: add [name] [phone]  or  add [name] [phone] [date 1-31]';

    // Last remaining arg is the phone number
    const phone = normalizePhone(mutableArgs.pop());
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
      });

      // Build the message sequence from config: group links + welcome message
      const groupLinks = config.groupLinks || [];
      const welcome = config.welcomeMessage
        ? config.welcomeMessage.replace(/\{name\}/g, name)
        : null;
      const messages = welcome ? [...groupLinks, welcome] : [...groupLinks];

      if (messages.length === 0) {
        return `✅ ${name} added to sheet.\n📅 Billing: ${billingDate}\n⚠️ No groupLinks configured — add them to config.json`;
      }

      const { sent, failed } = await groupManager.sendToMember(phone, messages);

      let reply = `✅ ${name} added to sheet.\n📅 Billing: ${billingDate}\n`;
      reply += `📨 Sent ${sent}/${messages.length} messages to ${phone}`;
      if (failed > 0) reply += ` (${failed} failed — check if number is on WhatsApp)`;
      reply += `\n\nWhen they join, use:\napprove ${phone}`;
      return reply;
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

  async function handleApprove(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: approve [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const { approved } = await groupManager.approvePendingRequests(phone);
    if (approved.length === 0) return `⚠️ No pending requests found for ${member.name}.`;
    return `✅ Approved ${member.name} in ${approved.length} group(s).`;
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
    const { approved, failed, totalApproved, totalGroups } = await groupManager.approveAllPendingRequests();

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

  async function handleRejoin(args) {
    if (args.length < 1) return '❌ Format: rejoin [phone]  or  rejoin [phone] [date 1-31]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Format: rejoin 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. New member? Use: add Name ${args[0]}`;
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

      const groupLinks = config.groupLinks || [];
      const welcome = config.welcomeMessage
        ? config.welcomeMessage.replace(/\{name\}/g, member.name)
        : null;
      const messages = welcome ? [...groupLinks, welcome] : [...groupLinks];

      if (messages.length === 0) {
        return `✅ ${member.name} reactivated.\n📅 Billing: ${billingDate}\n⚠️ No groupLinks in config.json`;
      }

      const { sent, failed } = await groupManager.sendToMember(phone, messages);
      let reply = `✅ ${member.name} reactivated.\n📅 Billing: ${billingDate}\n`;
      reply += `📨 Sent ${sent}/${messages.length} messages to ${phone}`;
      if (failed > 0) reply += ` (${failed} failed)`;
      reply += `\n\nWhen they join, use:\napprove ${phone}`;
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
    reply += `\n\nWhen they join, use:\napprove ${phone}`;
    return reply;
  }

  return { handleAdd, handleKick, handleSkip, handleUnskip, handleApprove, handleLinks, handleGroupCheck, handleApproveAll, handleSendLinks, handleRejoin };
}
