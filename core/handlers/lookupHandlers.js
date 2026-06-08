import { normalizePhone, daysFromToday, getReferralsInBillingPeriod } from '../globalConfig.js';

export function createLookupHandlers(store, config, log) {

  function handleFind(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: find [phone or name]';
    const query = args.join(' ').trim();

    const byPhone = store.findByPhone(query);
    if (byPhone) return formatMemberDetail(byPhone);

    const byName = store.findByName(query);
    if (byName.length === 0) return `❌ No member found for "${query}".`;
    if (byName.length === 1) return formatMemberDetail(byName[0]);

    const lines = byName.map(m => `• ${m.name} • ${m.phone} • ${m.status}`).join('\n');
    return `🔍 Found ${byName.length} matches for "${query}":\n\n${lines}\n\nUse find [phone] for full details.`;
  }

  function handleStatus(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: status [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const days = daysFromToday(member.billingDate);
    let daysLabel = '';
    if (days === null) daysLabel = 'no billing date';
    else if (days === 0) daysLabel = 'due TODAY';
    else if (days > 0) daysLabel = `due in ${days} days (${member.billingDate})`;
    else daysLabel = `${Math.abs(days)} days OVERDUE`;

    return `📋 ${member.name} (${phone})\nStatus: ${member.status}\nBilling: ${daysLabel}\nRenewals: ${member.renewals} | Last paid: ₹${member.paidLast}`;
  }

  function formatMemberDetail(m) {
    const days = daysFromToday(m.billingDate);
    const daysLabel = days === null ? 'unknown' : days >= 0 ? `${days}d remaining` : `${Math.abs(days)}d OVERDUE`;

    const all = store.getAll();
    const currentRefs = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
    const allTimeRefs = all.filter(r => r.reference && normalizePhone(r.reference) === m.phone);
    const refLine = allTimeRefs.length > 0
      ? `👥 Refs: ${currentRefs.length} this period (${currentRefs.length >= 2 ? '🎉 free renewal' : currentRefs.length === 1 ? `💰 ₹${config.renewal.referralAmount}` : `₹${config.renewal.fullAmount}`}) | ${allTimeRefs.length} all-time`
      : '';

    let referredByLine = '';
    if (m.reference) {
      const referrer = store.findByPhone(m.reference);
      referredByLine = referrer
        ? `🤝 Referred by: ${referrer.name} (${m.reference})`
        : `🤝 Referred by: ${m.reference}`;
    }

    return [
      `👤 ${m.name}`,
      `📱 ${m.phone}`,
      `📊 Status: ${m.status}`,
      `📅 Billing: ${m.billingDate} (${daysLabel})`,
      `🗓️ Joined: ${m.joinDate}`,
      `🔄 Renewals: ${m.renewals} | Last paid: ₹${m.paidLast}`,
      referredByLine,
      refLine,
      m.skipReason ? `⏭️ Skip reason: ${m.skipReason}` : '',
    ].filter(Boolean).join('\n');
  }

  return { handleFind, handleStatus };
}
