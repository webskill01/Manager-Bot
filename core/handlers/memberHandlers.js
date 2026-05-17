import { normalizePhone, formatDate, todayStr } from '../globalConfig.js';

export function createMemberHandlers(store, groupManager, config, log) {
  const inFlightAdds = new Set();

  async function handleAdd(args) {
    if (args.length < 2) return '❌ Missing arguments. Format: add [phone] [name]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return `❌ Invalid number. Use 10 digits: add 98551XXXXX Name`;
    const name = args.slice(1).join(' ').trim();
    if (name.length < 2) return '❌ Name too short. Format: add [phone] [name]';

    if (inFlightAdds.has(phone)) {
      return `⏳ Add for ${phone} already in progress — wait for it to finish.`;
    }

    const existing = store.findByPhone(phone);
    if (existing && existing.status === 'ACTIVE') {
      return `⚠️ ${existing.name} (${phone}) already ACTIVE. Use 'renewed' to update billing.`;
    }

    inFlightAdds.add(phone);
    try {
      const billingDate = formatDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

      if (existing && existing.status === 'REMOVED') {
        await store.update(phone, {
          status: 'ACTIVE',
          billingDate,
          joinDate: todayStr(),
          paidLast: config.joining.fee,
          skipReason: '',
        });
        log.info(`♻️  Reactivated ${name} (${phone})`);
      } else {
        await store.add({
          name,
          phone,
          joinDate: todayStr(),
          billingDate,
          paidLast: config.joining.fee,
        });
      }

      const { added, failed } = await groupManager.addToAllGroups(phone, name);
      let reply = `✅ Added ${name} to ${added.length}/${config.paidGroups.length} groups`;
      if (failed.length > 0) {
        const failedNames = failed.map(f => `   • ${f.groupId}`).join('\n');
        reply += `\n❌ Failed ${failed.length} groups (privacy restricted):\n${failedNames}`;
        reply += `\n\nReply: links ${phone}  (to get invite links for failed groups)`;
      }
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

    const { removed, failed } = await groupManager.removeFromAllGroups(phone);
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

  return { handleAdd, handleKick, handleSkip, handleUnskip, handleApprove, handleLinks, handleGroupCheck };
}
