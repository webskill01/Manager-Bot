import { normalizePhone, formatDate, todayStr, parseDate, getReferralsInBillingPeriod, clampedBillingDate, daysFromToday, overdueCohort } from '../globalConfig.js';

export function createMemberHandlers(store, groupManager, config, log) {
  const inFlightAdds = new Set();

  async function handleAdd(args) {
    if (args.length < 2) return '❌ Format: add [name] [phone]  or  add [name] [phone] [date 1-31]';

    const mutableArgs = [...args];

    // Extract optional "ref <refPhone> [prev|backdate]" suffix before any other parsing
    let referrerPhone = null;
    let isBackdate = false;
    const refIdx = mutableArgs.findIndex(a => a.toLowerCase() === 'ref');
    if (refIdx !== -1) {
      const refParts = mutableArgs.splice(refIdx); // removes 'ref' and everything after
      refParts.shift(); // drop 'ref' keyword
      isBackdate = refParts.some(p => ['prev', 'backdate'].includes(p.toLowerCase()));
      const phoneParts = refParts.filter(p => !['prev', 'backdate'].includes(p.toLowerCase()));
      if (phoneParts.length > 0) {
        const refNorm = normalizePhone(phoneParts.map(p => p.replace(/\D/g, '')).join(''));
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
      const billingDate = formatDate(clampedBillingDate(now.getFullYear(), now.getMonth() + 1, day));

      // Compute refCreditDate before add if backdating — pins referral to referrer's PREVIOUS billing window
      let refCreditDate = '';
      if (referrerPhone && isBackdate) {
        const ref = store.findByPhone(referrerPhone);
        if (ref) {
          const billing = parseDate(ref.billingDate);
          if (billing) {
            // billingDate - 1 month - 1 day → falls in [billingDate-2m, billingDate-1m), i.e. previous period
            refCreditDate = formatDate(new Date(billing.getFullYear(), billing.getMonth() - 1, billing.getDate() - 1));
          }
        }
      }

      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        paidLast: config.joining.fee,
        reference: referrerPhone || '',
        refCreditDate,
      });

      // Build referrer note (computed after add so store cache includes new member)
      let refNote = '';
      if (referrerPhone) {
        const referrer = store.findByPhone(referrerPhone);
        if (referrer) {
          // Append backdate audit log to referrer
          if (isBackdate && refCreditDate) {
            const billingObj = parseDate(referrer.billingDate);
            const periodStart = billingObj
              ? formatDate(new Date(billingObj.getFullYear(), billingObj.getMonth() - 2, billingObj.getDate()))
              : '?';
            const periodEnd = billingObj
              ? formatDate(new Date(billingObj.getFullYear(), billingObj.getMonth() - 1, billingObj.getDate()))
              : '?';
            const logEntry = `${name} (joined ${todayStr()}) backdated to ${periodStart}–${periodEnd} on ${todayStr()}`;
            const newLog = referrer.refLog ? `${referrer.refLog} | ${logEntry}` : logEntry;
            await store.update(referrerPhone, { refLog: newLog });
          }
          const refs = getReferralsInBillingPeriod(referrerPhone, referrer.billingDate, store.getAll()).length;
          const refTag = refs >= 2 ? `🎁 ${refs} refs this month — free renewal`
            : refs === 1 ? `★ 1 ref this month — ₹${config.renewal.referralAmount}` : '0 refs';
          const backdateNote = refCreditDate ? ' ⏪ backdated' : '';
          refNote = `\n👥 Referrer: ${referrer.name} — ${refTag}${backdateNote}`;
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
      if (existing.status === 'ACTIVE') return `⚠️ ${existing.name} (${phone}) already ACTIVE.\nTo add them to all groups: rejoin ${phone}`;
      if (existing.status === 'REMOVED') return `⚠️ ${existing.name} already in sheet as REMOVED. Use: rejoin ${phone}`;
      if (existing.status === 'SKIPPED') return `⚠️ ${existing.name} already SKIPPED. Use: unskip ${phone}`;
    }

    inFlightAdds.add(phone);
    try {
      const now = new Date();
      const day = billingDay ?? now.getDate();
      const billingDate = formatDate(clampedBillingDate(now.getFullYear(), now.getMonth() + 1, day));

      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        // paidLast 0 → flags this as a silent/existing-member add: NOT counted as a new
        // member or join revenue in any report (summary/weekly/monthly/revenue/growth/churn).
        paidLast: 0,
        reference: '',
      });

      log.info(`📋 Silent add: ${name} (${phone}) — not counted as new member`);
      return `✅ ${name} (${phone}) added to sheet (no links sent, not counted as new member).\n📅 Billing: ${billingDate}\n\nNow use:\nrejoin ${phone}  →  adds directly to all groups`;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  // Like handleAdd (counts as a NEW paying member, stores joining fee) but sends NO links.
  // For the "share links manually → person pays → add to sheet" flow (sendlinks then addnew).
  async function handleNewAdd(args) {
    if (args.length < 2) return '❌ Format: addnew [Name] [phone]  or  addnew [Name] [phone] [day 1-31]';

    const mutableArgs = [...args];

    // Optional "ref <refPhone> [prev|backdate]" suffix — same parsing as handleAdd
    let referrerPhone = null;
    let isBackdate = false;
    const refIdx = mutableArgs.findIndex(a => a.toLowerCase() === 'ref');
    if (refIdx !== -1) {
      const refParts = mutableArgs.splice(refIdx);
      refParts.shift();
      isBackdate = refParts.some(p => ['prev', 'backdate'].includes(p.toLowerCase()));
      const phoneParts = refParts.filter(p => !['prev', 'backdate'].includes(p.toLowerCase()));
      if (phoneParts.length > 0) {
        const refNorm = normalizePhone(phoneParts.map(p => p.replace(/\D/g, '')).join(''));
        if (refNorm.length === 10) referrerPhone = refNorm;
      }
    }

    // Pop optional billing day (1–31) from end
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

    if (phoneParts.length === 0) return '❌ Format: addnew [Name] [phone]';
    const phone = normalizePhone(phoneParts.join(''));
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits.';
    const name = mutableArgs.join(' ').trim();
    if (name.length < 2) return '❌ Name too short.';

    if (inFlightAdds.has(phone)) return `⏳ Operation for ${phone} already in progress.`;

    const existing = store.findByPhone(phone);
    if (existing) {
      if (existing.status === 'ACTIVE') return `⚠️ ${existing.name} (${phone}) already ACTIVE. Use 'renewed' to update billing.`;
      if (existing.status === 'REMOVED') return `⚠️ ${existing.name} already in sheet as REMOVED. Use: rejoin ${phone}`;
      if (existing.status === 'SKIPPED') return `⚠️ ${existing.name} already SKIPPED. Use: unskip ${phone}`;
    }

    inFlightAdds.add(phone);
    try {
      const now = new Date();
      const day = billingDay ?? now.getDate();
      const billingDate = formatDate(clampedBillingDate(now.getFullYear(), now.getMonth() + 1, day));

      // Compute refCreditDate before add if backdating — pins referral to referrer's PREVIOUS window
      let refCreditDate = '';
      if (referrerPhone && isBackdate) {
        const ref = store.findByPhone(referrerPhone);
        if (ref) {
          const billing = parseDate(ref.billingDate);
          if (billing) {
            refCreditDate = formatDate(new Date(billing.getFullYear(), billing.getMonth() - 1, billing.getDate() - 1));
          }
        }
      }

      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        // joining fee → counts as a NEW member + join revenue in reports (unlike addsilent's 0).
        paidLast: config.joining.fee,
        reference: referrerPhone || '',
        refCreditDate,
      });

      let refNote = '';
      if (referrerPhone) {
        const referrer = store.findByPhone(referrerPhone);
        if (referrer) {
          if (isBackdate && refCreditDate) {
            const billingObj = parseDate(referrer.billingDate);
            const periodStart = billingObj
              ? formatDate(new Date(billingObj.getFullYear(), billingObj.getMonth() - 2, billingObj.getDate()))
              : '?';
            const periodEnd = billingObj
              ? formatDate(new Date(billingObj.getFullYear(), billingObj.getMonth() - 1, billingObj.getDate()))
              : '?';
            const logEntry = `${name} (joined ${todayStr()}) backdated to ${periodStart}–${periodEnd} on ${todayStr()}`;
            const newLog = referrer.refLog ? `${referrer.refLog} | ${logEntry}` : logEntry;
            await store.update(referrerPhone, { refLog: newLog });
          }
          const refs = getReferralsInBillingPeriod(referrerPhone, referrer.billingDate, store.getAll()).length;
          const refTag = refs >= 2 ? `🎁 ${refs} refs this month — free renewal`
            : refs === 1 ? `★ 1 ref this month — ₹${config.renewal.referralAmount}` : '0 refs';
          const backdateNote = refCreditDate ? ' ⏪ backdated' : '';
          refNote = `\n👥 Referrer: ${referrer.name} — ${refTag}${backdateNote}`;
        } else {
          refNote = `\n⚠️ Referrer ${referrerPhone} not found in sheet.`;
        }
      }

      log.info(`📋 New add (no links): ${name} (${phone}) — counted as new member`);
      return `✅ ${name} (${phone}) added to sheet as a NEW member (no links sent).\n📅 Billing: ${billingDate}${refNote}\n\nNow use:\nrejoin ${phone}  →  adds directly to all groups`;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  async function handleKick(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: kick [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: kick 98551XXXXX';

    // Works for ANY number — attempts group removal even if already REMOVED in
    // the sheet (a "ghost" can be marked REMOVED yet still physically in a group).
    const member = store.findByPhone(phone);

    const result = await groupManager.removeFromAllGroups(phone);
    if (result.blocked) return result.blocked;
    const { removed, failed } = result;

    if (member) {
      const wasRemoved = member.status === 'REMOVED';
      if (!wasRemoved) await store.update(phone, { status: 'REMOVED' });
      const note = wasRemoved ? ' (already REMOVED in sheet)' : '';
      let reply = `✅ Removed ${member.name} from ${removed.length}/${config.paidGroups.length} groups${note}`;
      if (failed.length > 0) reply += `\n⚠️ Failed ${failed.length} groups — sheet still marked REMOVED.`;
      return reply;
    }

    // Not in sheet — removed from groups only, no sheet update
    let reply = `✅ Removed ${phone} from ${removed.length}/${config.paidGroups.length} groups (not in sheet)`;
    if (failed.length > 0) reply += `\n⚠️ Failed ${failed.length} groups.`;
    return reply;
  }

  async function handleSkip(args) {
    if (args.length < 2) return '❌ Missing arguments. Format: skip [phone] [reason]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: skip 98551XXXXX reason';
    const reason = args.slice(1).join(' ');

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    // Advance billing date by one month so they aren't billed this cycle
    const currentBilling = parseDate(member.billingDate);
    let newBillingDate = member.billingDate;
    if (currentBilling) {
      const next = clampedBillingDate(currentBilling.getFullYear(), currentBilling.getMonth() + 1, currentBilling.getDate());
      newBillingDate = formatDate(next);
    }

    await store.update(phone, { status: 'SKIPPED', skipReason: reason, billingDate: newBillingDate });
    return `✅ ${member.name} marked SKIPPED — won't appear in auto-remove list.\nReason: ${reason}\n📅 Billing pushed to: ${newBillingDate}`;
  }

  async function handleDelay(args) {
    if (args.length < 1) return '❌ Format: delay [phone] [days]  (e.g. delay 98551XXXXX 1 — default 1 day)';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: delay 98551XXXXX 1';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status !== 'ACTIVE') return `⚠️ ${member.name} is ${member.status} — delay only works for ACTIVE members.`;

    // Optional day count (default 1). "delay 98xxx" → tomorrow, "delay 98xxx 0" → today only.
    let days = 1;
    if (args[1] !== undefined) {
      if (!/^\d{1,2}$/.test(args[1])) return '❌ Days must be a number 0–31. Format: delay [phone] [days]';
      days = parseInt(args[1], 10);
    }
    days = Math.min(Math.max(days, 0), 31);

    const until = new Date();
    until.setHours(0, 0, 0, 0);
    until.setDate(until.getDate() + days);
    const delayUntil = formatDate(until);

    await store.update(phone, { delayUntil });

    const overdueDays = daysFromToday(member.billingDate);
    const overdueLabel = overdueDays !== null && overdueDays < 0
      ? ` (currently ${Math.abs(overdueDays)}d overdue)` : '';
    log.info(`⏸️  Delayed ${member.name} (${phone}) until ${delayUntil} [${days}d]`);
    return `⏸️ ${member.name} (${phone}) delayed until ${delayUntil}${overdueLabel}.\n` +
      `Hidden from the removal list until then — still tracked as overdue.\n` +
      `Reappears for removal after ${delayUntil} if still unpaid.`;
  }

  // Bulk `delay` — pauses the removal clock for everyone currently overdue, without
  // touching BILLING_DATE. Used after an outage so members aren't kicked for downtime
  // the bot caused. Preview by default; `delayall 7 confirm` applies (same
  // preview/confirm shape as kickghosts).
  async function handleDelayAll(args) {
    if (args.length < 1) return '❌ Format: delayall [days] [confirm]  (e.g. delayall 7 confirm)';
    if (!/^\d{1,2}$/.test(args[0])) return '❌ Days must be a number 0–31. Format: delayall [days] [confirm]';
    const days = Math.min(Math.max(parseInt(args[0], 10), 0), 31);
    const confirm = args[1]?.toLowerCase() === 'confirm';

    await store.refresh();
    const cohort = overdueCohort(store.getAll());
    if (cohort.length === 0) return '✅ Nobody is overdue right now — nothing to delay.';

    const until = new Date();
    until.setHours(0, 0, 0, 0);
    until.setDate(until.getDate() + days);
    const delayUntil = formatDate(until);

    const lines = cohort.slice(0, 15)
      .map((m, i) => `${i + 1}. ${m.name} (${m.phone}) — ${Math.abs(daysFromToday(m.billingDate))}d overdue`);
    const more = cohort.length > 15 ? `\n…and ${cohort.length - 15} more` : '';

    if (!confirm) {
      return `⏸️ DELAYALL PREVIEW — ${cohort.length} overdue member(s)\n\n${lines.join('\n')}${more}\n\n` +
        `Would delay all of them until ${delayUntil} (${days}d).\n` +
        `Billing dates are NOT changed — nobody's billing day shifts.\n\n` +
        `To apply: delayall ${days} confirm`;
    }

    let ok = 0;
    const failed = [];
    for (const m of cohort) {
      try {
        await store.update(m.phone, { delayUntil }, { skipRefresh: true });
        ok++;
      } catch (err) {
        failed.push(m.phone);
        log.warn(`⚠️  delayall failed for ${m.phone}: ${err.message}`);
      }
    }
    await store.refresh();

    log.info(`⏸️  delayall — ${ok}/${cohort.length} member(s) delayed until ${delayUntil}`);
    return `⏸️ Delayed ${ok} member(s) until ${delayUntil} (${days}d).\n` +
      `Billing dates unchanged — everyone still bills on their original day.\n` +
      `Hidden from final reminders and the removal list until then.` +
      (failed.length ? `\n\n⚠️ Failed for ${failed.length}: ${failed.join(', ')}` : '');
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

    // Works for ANY number — sheet membership is not required.
    const member = store.findByPhone(phone);
    const who = member ? `${member.name} (${phone})` : `${phone} (not in sheet)`;

    const { inGroups, notInGroups } = await groupManager.checkMembership(phone);
    let reply = `📋 ${who} group membership:\n`;
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
    if (member.status === 'SKIPPED') return `⚠️ ${member.name} is SKIPPED. Use 'unskip ${phone}' first, then rejoin.`;
    if (member.status !== 'REMOVED' && member.status !== 'ACTIVE') return `⚠️ ${member.name} is ${member.status}. Cannot rejoin.`;

    if (inFlightAdds.has(phone)) return `⏳ Operation for ${phone} already in progress.`;

    // ACTIVE = addsilent flow (already in sheet, just needs group add — don't touch billing)
    // REMOVED = full reactivation (update sheet + group add)
    const isReactivation = member.status === 'REMOVED';

    let billingDay = null;
    if (isReactivation && args[1] && /^\d{1,2}$/.test(args[1]) && parseInt(args[1]) >= 1 && parseInt(args[1]) <= 31) {
      billingDay = parseInt(args[1]);
    }

    inFlightAdds.add(phone);
    try {
      let billingDate = member.billingDate;

      if (isReactivation) {
        const now = new Date();
        const day = billingDay ?? now.getDate();
        billingDate = formatDate(clampedBillingDate(now.getFullYear(), now.getMonth() + 1, day));
        await store.update(phone, {
          status: 'ACTIVE',
          billingDate,
          joinDate: todayStr(),
          paidLast: config.joining.fee,
          skipReason: '',
        });
      }
      log.info(`♻️  Reactivating ${member.name} (${phone}) in sheet [${isReactivation ? 'reactivation' : 'addsilent flow'}]`);

      let reply = isReactivation
        ? `✅ ${member.name} reactivated in sheet.\n📅 Billing: ${billingDate}`
        : `✅ ${member.name} sheet updated.\n📅 Billing: ${billingDate}`;

      reply += `\n\n👆 Now manually add ${member.name} (${phone}) to all groups from your WhatsApp.`;

      return reply;
    } finally {
      inFlightAdds.delete(phone);
    }
  }

  async function handleSendLinks(args) {
    if (args.length < 1) return '❌ Format: sendlinks [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    // Works for ANY number — sheet membership is not required (e.g. fresh prospects).
    const member = store.findByPhone(phone);

    const groupLinks = config.groupLinks || [];
    const welcome = config.welcomeMessage
      ? config.welcomeMessage.replace(/\{name\}/g, member?.name || 'ji')
      : null;
    const messages = welcome ? [...groupLinks, welcome] : [...groupLinks];

    if (messages.length === 0) return '⚠️ No groupLinks configured in config.json';

    const { sent, failed } = await groupManager.sendToMember(phone, messages);
    const who = member ? `${member.name} (${phone})` : phone;
    let reply = `📨 Sent ${sent}/${messages.length} messages to ${who}`;
    if (!member) reply += `\nℹ️ ${phone} is not in the sheet — links sent anyway.`;
    if (failed > 0) reply += `\n⚠️ ${failed} failed — check if number is on WhatsApp`;
    reply += `\n\nWhen they join, use:\napprove  (approves all pending across all groups)`;
    return reply;
  }

  async function handleRef(parts) {
    // parts: [memberPhone, 'ref', ...referrerPhoneParts, optionally 'prev'/'backdate']
    if (parts.length < 3) return '❌ Format: [phone] ref [refPhone]  Example: 9876543210 ref 6284001093';
    const phone = normalizePhone(parts[0]);
    if (phone.length !== 10) return '❌ Invalid member phone.';

    const afterRef = parts.slice(2);
    const isBackdate = afterRef.some(p => ['prev', 'backdate'].includes(p.toLowerCase()));
    const refNorm = normalizePhone(
      afterRef.filter(p => !['prev', 'backdate'].includes(p.toLowerCase()))
        .map(p => p.replace(/\D/g, '')).join('')
    );
    if (refNorm.length !== 10) return '❌ Invalid referrer phone.';
    if (phone === refNorm) return '❌ Cannot set yourself as your own referrer.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${parts[0]}. Try: find [name]`;

    const referrer = store.findByPhone(refNorm);
    let warning = referrer ? '' : `\n⚠️ Referrer ${refNorm} not found in sheet — reference recorded anyway.`;

    // Compute refCreditDate: pin to previous billing period (billingDate - 1 month - 1 day)
    // This ensures the ref falls in [billingDate-2m, billingDate-1m), NOT the current window
    let refCreditDate = '';
    let backdateNote = '';
    if (isBackdate && referrer) {
      const billing = parseDate(referrer.billingDate);
      if (billing) {
        refCreditDate = formatDate(new Date(billing.getFullYear(), billing.getMonth() - 1, billing.getDate() - 1));
        const periodStart = formatDate(new Date(billing.getFullYear(), billing.getMonth() - 2, billing.getDate()));
        const periodEnd   = formatDate(new Date(billing.getFullYear(), billing.getMonth() - 1, billing.getDate()));
        backdateNote = `\n⏪ Backdated to ${periodStart}–${periodEnd} window`;
      }
    }

    await store.update(phone, { reference: refNorm, ...(refCreditDate ? { refCreditDate } : {}) });

    // Append audit log to referrer
    if (isBackdate && referrer && refCreditDate) {
      const billing = parseDate(referrer.billingDate);
      const periodStart = billing
        ? formatDate(new Date(billing.getFullYear(), billing.getMonth() - 2, billing.getDate()))
        : '?';
      const periodEnd = billing
        ? formatDate(new Date(billing.getFullYear(), billing.getMonth() - 1, billing.getDate()))
        : '?';
      const logEntry = `${member.name} (joined ${member.joinDate}) backdated to ${periodStart}–${periodEnd} on ${todayStr()}`;
      const newLog = referrer.refLog ? `${referrer.refLog} | ${logEntry}` : logEntry;
      await store.update(refNorm, { refLog: newLog });
    }

    if (referrer) {
      const refs = getReferralsInBillingPeriod(refNorm, referrer.billingDate, store.getAll()).length;
      const refTag = refs >= 2 ? `🎁 ${refs} refs this month — free renewal`
        : refs === 1 ? `★ 1 ref this month — ₹${config.renewal.referralAmount}` : '0 refs this month';
      return `✅ ${member.name}'s referrer set to ${referrer.name} (${refNorm})\n${referrer.name}: ${refTag}${backdateNote}`;
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
      msg += currentRefs.map(m => {
        const tag = m.refCreditDate ? ' ⏪ backdated' : '';
        return `  • ${m.name}  ${m.phone}  Joined ${m.joinDate}${tag}`;
      }).join('\n') + '\n';
    }
    const countLine = currentRefs.length === 0
      ? `  Count: 0`
      : currentRefs.length >= 2
        ? `  Count: ${currentRefs.length} → 🎉 Free renewal on ${member.billingDate}`
        : `  Count: 1 → 💰 ₹${config.renewal.referralAmount} on ${member.billingDate}`;
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

  async function handleApprovePhone(args) {
    if (args.length < 1) return '❌ Format: approve [phone]  or  approve (no number = all)';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits.';
    const { found, approved, failed } = await groupManager.approveByPhone(phone);
    if (found === 0) return `❌ No pending request found for ${phone}. They may not have tried to join yet.`;
    return `✅ Approved ${phone} in ${approved}/${found} group(s)${failed > 0 ? ` (${failed} failed)` : ''}`;
  }

  async function handleRejectPhone(args) {
    if (args.length < 1) return '❌ Format: reject [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits.';
    const { found, rejected, failed } = await groupManager.rejectByPhone(phone);
    if (found === 0) return `❌ No pending request found for ${phone}.`;
    return `✅ Rejected ${phone} in ${rejected}/${found} group(s)${failed > 0 ? ` (${failed} failed)` : ''}`;
  }

  return { handleAdd, handleSilentAdd, handleNewAdd, handleKick, handleSkip, handleUnskip, handleDelay, handleDelayAll, handleLinks, handleGroupCheck, handleApproveAll, handleRejectAll, handleApprovePhone, handleRejectPhone, handleSendLinks, handleRejoin, handleRef, handleRefs };
}
