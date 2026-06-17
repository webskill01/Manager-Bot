import { normalizePhone, formatDate, todayStr, daysFromToday, formatDateTime, getReferralsInBillingPeriod, nextBillingForDay, isDelayActive, clampedBillingDate, parseDate } from '../globalConfig.js';
import { markPhoneReminded } from '../reminderSender.js';

export function createRenewalHandlers(store, config, log) {

  async function handleRenewed(args) {
    if (args.length < 1) return '❌ Format: renewed [phone]  or  renewed [phone] 45  or  renewed [phone] [date 1-31]  or  renewed [phone] [date] 45';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: renewed 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    // Parse remaining args: '45' → referral, 1–31 → billing day, 'force' → override same-month block
    let amount = config.renewal.fullAmount;
    let billingDay = null;
    const isForce = args.slice(1).some(a => a.toLowerCase() === 'force');
    for (const arg of args.slice(1)) {
      if (arg === '45') {
        amount = config.renewal.referralAmount;
      } else if (/^\d{1,2}$/.test(arg) && parseInt(arg) >= 1 && parseInt(arg) <= 31) {
        billingDay = parseInt(arg);
      }
    }

    // Same-month renewal guard — blocks accidental double-renewal
    if (!isForce && member.lastRenewed) {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = String(now.getFullYear());
      const lr = member.lastRenewed;
      const inThisMonth = (lr.length >= 10 && lr[2] === '-')
        ? lr.slice(3, 5) === mm && lr.slice(6, 10) === yyyy
        : lr.startsWith(`${yyyy}-${mm}`);
      if (inThisMonth) {
        return `⚠️ ${member.name} was already renewed this month (${member.lastRenewed}).\nTo override: renewed ${phone} force`;
      }
    }

    // Advance payment (force, no explicit day, billing already today-or-future): the member
    // has already paid the current cycle and is paying ahead. Stack ONE more month onto their
    // existing billing date, preserving the billing day-of-month — don't reset to today.
    const currentBilling = parseDate(member.billingDate);
    const billingInFuture = currentBilling !== null && (daysFromToday(member.billingDate) ?? -1) >= 0;
    const isAdvance = isForce && billingDay === null && billingInFuture;

    let newBillingDate;
    if (isAdvance) {
      newBillingDate = formatDate(
        clampedBillingDate(currentBilling.getFullYear(), currentBilling.getMonth() + 1, currentBilling.getDate())
      );
    } else {
      // Next billing = soonest occurrence of `day` strictly after today (clamped for short months).
      // A specified day is treated as the member's anniversary day in the recent PAST, so on
      // 1 Jun "renewed X 28" → 28 Jun (this month), not 28 Jul. No day given → one month from today.
      const day = billingDay !== null ? billingDay : new Date().getDate();
      newBillingDate = formatDate(nextBillingForDay(day));
    }

    await store.update(phone, {
      status: 'ACTIVE',
      billingDate: newBillingDate,
      renewals: member.renewals + 1,
      paidLast: amount,
      lastRenewed: formatDateTime(new Date()),
      delayUntil: '', // clear any pending payment-delay snooze on renewal
    });

    // Belt-and-suspenders against the double-reminder bug: mark this phone handled in
    // today's reminder state so a same-day batch can never target a just-renewed member.
    if (config.botDir) markPhoneReminded(config.botDir, phone);

    const type = amount === config.renewal.fullAmount ? 'full' : 'referral';
    if (isAdvance) {
      return `✅ ${member.name} — advance payment @ ₹${amount} (${type})\n📦 Billing extended a month → ${newBillingDate}\n🔄 Total renewals: ${member.renewals + 1}`;
    }
    return `✅ ${member.name} renewed @ ₹${amount} (${type})\n📅 Next billing: ${newBillingDate}\n🔄 Total renewals: ${member.renewals + 1}`;
  }

  function handleDue(args) {
    // Resolve the time arg tolerantly. A strict `=== 'tomorrow'` silently fell back to
    // "today" on any typo (tommorow / tmrw / Tomorrow / kal), making `due tomorrow` look
    // identical to `due`. Accept common variants, Hindi "kal", and a numeric N-days offset.
    const raw = (args[0] || '').toLowerCase().trim();
    const TOMORROW = new Set(['tomorrow', 'tomorow', 'tommorow', 'tommorrow', 'tmrw', 'tmr', 'tom', 'tomm', 'kal']);
    const TODAY = new Set(['today', 'aaj', '0']);

    let targetDays = 0;
    let unknownArg = '';
    if (!raw || TODAY.has(raw)) {
      targetDays = 0;
    } else if (TOMORROW.has(raw)) {
      targetDays = 1;
    } else if (/^\d{1,2}$/.test(raw) && parseInt(raw) <= 31) {
      targetDays = parseInt(raw); // "due 3" → 3 days from now
    } else {
      unknownArg = args[0]; // unrecognized — default to today but tell the operator
    }

    const label = targetDays === 0 ? 'today' : targetDays === 1 ? 'tomorrow' : `in ${targetDays} days`;
    const dateStr = formatDate(new Date(Date.now() + targetDays * 24 * 60 * 60 * 1000));
    const hint = unknownArg ? `⚠️ Didn't recognize "${unknownArg}" — showing today. Try: due tomorrow  /  due 3\n\n` : '';

    const active = store.getActive();
    const due = active.filter(m => daysFromToday(m.billingDate) === targetDays);

    if (due.length === 0) return `${hint}📅 No members due ${label} (${dateStr}).`;

    const all = store.getAll();
    const lines = due.map(m => {
      const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
      const refTag = refs >= 2 ? '  🎁 2 refs this month — auto-renew'
        : refs === 1 ? `  ★ 1 ref — ₹${config.renewal.referralAmount}` : '';
      return `• ${m.name} • ${m.phone}${refTag}`;
    }).join('\n');
    return `${hint}📅 Due ${label} — ${dateStr} (${due.length} members):\n\n${lines}`;
  }

  function handleOverdue() {
    const active = store.getActive();
    const overdue = active
      .filter(m => {
        const days = daysFromToday(m.billingDate);
        return days !== null && days < 0;
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    if (overdue.length === 0) return '✅ No overdue members.';

    const lines = overdue.map((m, i) => {
      const delayTag = isDelayActive(m) ? `  ⏸️ delayed→${m.delayUntil}` : '';
      return `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue${delayTag}`;
    }).join('\n');

    return `⚠️ OVERDUE MEMBERS — ${todayStr()} (${overdue.length} members):\n\n${lines}\n\nReply: R[n]=Remove, S[n]=Skip, W[n]=Warn\nExample: R1 R2 S3`;
  }

  function handlePending() {
    const active = store.getActive();
    const pending = active.filter(m => {
      const days = daysFromToday(m.billingDate);
      return days !== null && days <= 0;
    });

    if (pending.length === 0) return '✅ No pending renewals.';

    const all = store.getAll();
    const lines = pending.map(m => {
      const days = Math.abs(daysFromToday(m.billingDate));
      const label = days === 0 ? 'due today' : `${days}d overdue`;
      const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
      const refTag = refs >= 2 ? '  🎁 2 refs' : refs === 1 ? '  ★ 1 ref' : '';
      const delayTag = isDelayActive(m) ? `  ⏸️ delayed→${m.delayUntil}` : '';
      return `• ${m.name} • ${m.phone} • ${label}${refTag}${delayTag}`;
    }).join('\n');

    return `⏳ PENDING RENEWALS (${pending.length}):\n\n${lines}`;
  }

  return { handleRenewed, handleDue, handleOverdue, handlePending };
}
