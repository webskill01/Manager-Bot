import { normalizePhone, formatDate, todayStr, daysFromToday } from '../globalConfig.js';

export function createRenewalHandlers(store, config, log) {

  async function handleRenewed(args) {
    if (args.length < 1) return '❌ Format: renewed [phone]  or  renewed [phone] 45  or  renewed [phone] [date 1-31]  or  renewed [phone] [date] 45';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: renewed 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    // Parse remaining args: '45' → referral, a number 1–31 → custom billing day
    let amount = config.renewal.fullAmount;
    let billingDay = null;
    for (const arg of args.slice(1)) {
      if (arg === '45') {
        amount = config.renewal.referralAmount;
      } else if (/^\d{1,2}$/.test(arg) && parseInt(arg) >= 1 && parseInt(arg) <= 31) {
        billingDay = parseInt(arg);
      }
    }

    let newBillingDate;
    if (billingDay !== null) {
      const now = new Date();
      newBillingDate = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, billingDay));
    } else {
      newBillingDate = formatDate(
        new Date(Date.now() + config.renewal.billingCycleDays * 24 * 60 * 60 * 1000)
      );
    }

    await store.update(phone, {
      status: 'ACTIVE',
      billingDate: newBillingDate,
      renewals: member.renewals + 1,
      paidLast: amount,
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

    const lines = due.map(m => `• ${m.name} • ${m.phone}`).join('\n');
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

    const lines = pending.map(m => {
      const days = Math.abs(daysFromToday(m.billingDate));
      const label = days === 0 ? 'due today' : `${days}d overdue`;
      return `• ${m.name} • ${m.phone} • ${label}`;
    }).join('\n');

    return `⏳ PENDING RENEWALS (${pending.length}):\n\n${lines}`;
  }

  return { handleRenewed, handleDue, handleOverdue, handlePending };
}
