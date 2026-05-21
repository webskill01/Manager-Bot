import { normalizePhone, formatDate, todayStr, daysFromToday, formatDateTime, getReferralsInBillingPeriod } from '../globalConfig.js';

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

    // Anchor on today: same day number, next calendar month.
    // JS Date handles month-end overflow (e.g. May 31 → June 30, Jan 31 → Feb 28).
    const now = new Date();
    const day = billingDay !== null ? billingDay : now.getDate();
    const newBillingDate = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, day));

    await store.update(phone, {
      status: 'ACTIVE',
      billingDate: newBillingDate,
      renewals: member.renewals + 1,
      paidLast: amount,
      lastRenewed: formatDateTime(new Date()),
    });

    const type = amount === config.renewal.fullAmount ? 'full' : 'referral';
    return `✅ ${member.name} renewed @ ₹${amount} (${type})\n📅 Next billing: ${newBillingDate}\n🔄 Total renewals: ${member.renewals + 1}`;
  }

  function handleDue(args) {
    const tomorrow = args[0] === 'tomorrow';
    const targetDays = tomorrow ? 1 : 0;
    const label = tomorrow ? 'tomorrow' : 'today';
    const dateStr = formatDate(new Date(Date.now() + targetDays * 24 * 60 * 60 * 1000));

    const active = store.getActive();
    const due = active.filter(m => daysFromToday(m.billingDate) === targetDays);

    if (due.length === 0) return `📅 No members due ${label} (${dateStr}).`;

    const all = store.getAll();
    const lines = due.map(m => {
      const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
      const refTag = refs >= 2 ? '  🎁 2 refs this month — auto-renew'
        : refs === 1 ? '  ★ 1 ref — ₹45' : '';
      return `• ${m.name} • ${m.phone}${refTag}`;
    }).join('\n');
    return `📅 Due ${label} — ${dateStr} (${due.length} members):\n\n${lines}`;
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

    const lines = overdue.map((m, i) =>
      `[${i + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue`
    ).join('\n');

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
      return `• ${m.name} • ${m.phone} • ${label}${refTag}`;
    }).join('\n');

    return `⏳ PENDING RENEWALS (${pending.length}):\n\n${lines}`;
  }

  return { handleRenewed, handleDue, handleOverdue, handlePending };
}
