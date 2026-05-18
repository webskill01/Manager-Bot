import { daysFromToday, todayStr } from '../globalConfig.js';

export function createReportHandlers(store, config, botStartTime, log) {

  // Checks lastUpdated against a given date string ("DD-MM-YYYY") — handles both storage formats
  function isUpdatedOn(lastUpdated, dateStr) {
    if (!lastUpdated) return false;
    if (lastUpdated.startsWith(dateStr)) return true;
    // Old ISO format: convert DD-MM-YYYY → YYYY-MM-DD for comparison
    const [d, m, y] = dateStr.split('-');
    return lastUpdated.startsWith(`${y}-${m}-${d}`);
  }

  function isUpdatedToday(lastUpdated) {
    return isUpdatedOn(lastUpdated, todayStr());
  }

  // Checks if lastUpdated is within current month — handles both formats
  function isUpdatedThisMonth(lastUpdated) {
    if (!lastUpdated) return false;
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    // New format: "DD-MM-YYYY HH:MM" — month at [3:5], year at [6:10]
    if (lastUpdated.length >= 10 && lastUpdated[2] === '-') {
      return lastUpdated.slice(3, 5) === mm && lastUpdated.slice(6, 10) === yyyy;
    }
    // Old ISO format: "YYYY-MM-..."
    return lastUpdated.startsWith(`${yyyy}-${mm}`);
  }

  function handleMorningDigest() {
    const all = store.getAll();
    const dueToday = all.filter(m => m.status === 'ACTIVE' && daysFromToday(m.billingDate) === 0);
    const overdue = all.filter(m => {
      const d = daysFromToday(m.billingDate);
      return m.status === 'ACTIVE' && d !== null && d < 0;
    }).sort((a, b) => (daysFromToday(a.billingDate) || 0) - (daysFromToday(b.billingDate) || 0));
    const warnToday = overdue.filter(m => Math.abs(daysFromToday(m.billingDate) || 0) >= 6);
    const totalActive = all.filter(m => m.status === 'ACTIVE').length;
    const totalSkipped = all.filter(m => m.status === 'SKIPPED').length;

    const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

    let msg = `☀️ Morning Digest — ${dateStr}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `📅 DUE TODAY: ${dueToday.length} member${dueToday.length !== 1 ? 's' : ''}\n`;
    if (dueToday.length > 0) {
      msg += dueToday.map(m => `   • ${m.name}  ${m.phone}`).join('\n') + '\n';
    }

    msg += `\n⚠️ OVERDUE: ${overdue.length} member${overdue.length !== 1 ? 's' : ''}\n`;
    if (overdue.length > 0) {
      const show = overdue.slice(0, 8);
      msg += show.map(m => `   • ${m.name}  (${Math.abs(daysFromToday(m.billingDate))}d overdue)`).join('\n');
      if (overdue.length > 8) msg += `\n   ... +${overdue.length - 8} more`;
      msg += '\n';
    }

    if (warnToday.length > 0) {
      msg += `\n🚨 AUTO-WARN TODAY (6+ days): ${warnToday.length} member${warnToday.length !== 1 ? 's' : ''}\n`;
      msg += warnToday.map(m => `   • ${m.name}  (${Math.abs(daysFromToday(m.billingDate))}d)`).join('\n') + '\n';
    }

    msg += `\n📊 Active: ${totalActive}  |  Overdue: ${overdue.length}  |  Due today: ${dueToday.length}  |  Skipped: ${totalSkipped}`;

    return msg;
  }

  function handleSummary(args = []) {
    const all = store.getAll();

    // Parse optional days-ago argument: "summary 1" = yesterday, "summary 2" = 2 days ago
    let daysAgo = 0;
    if (args.length > 0) {
      const arg = String(args[0]).toLowerCase();
      if (arg === 'yesterday') daysAgo = 1;
      else if (/^\d+$/.test(arg)) daysAgo = Math.min(parseInt(arg, 10), 30);
    }

    const targetDateObj = new Date();
    if (daysAgo > 0) targetDateObj.setDate(targetDateObj.getDate() - daysAgo);
    const targetDateStr = [
      String(targetDateObj.getDate()).padStart(2, '0'),
      String(targetDateObj.getMonth() + 1).padStart(2, '0'),
      String(targetDateObj.getFullYear()),
    ].join('-'); // "DD-MM-YYYY"

    const newToday = all.filter(m => m.joinDate === targetDateStr);
    const renewedToday = all.filter(m =>
      isUpdatedOn(m.lastUpdated, targetDateStr) && m.renewals > 0 && m.joinDate !== targetDateStr
    );
    const removedToday = all.filter(m =>
      m.status === 'REMOVED' && isUpdatedOn(m.lastUpdated, targetDateStr)
    );
    const overdue = all.filter(m => {
      const days = daysFromToday(m.billingDate);
      return m.status === 'ACTIVE' && days !== null && days < -5;
    });
    const totalActive = all.filter(m => m.status === 'ACTIVE').length;

    const joinRevenue = newToday.length * config.joining.fee;
    const fullRenewals = renewedToday.filter(m => m.paidLast === config.renewal.fullAmount);
    const referralRenewals = renewedToday.filter(m => m.paidLast === config.renewal.referralAmount);
    const renewalRevenue =
      fullRenewals.length * config.renewal.fullAmount +
      referralRenewals.length * config.renewal.referralAmount;
    const totalRevenue = joinRevenue + renewalRevenue;

    const dateStr = targetDateObj.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const dateLabel = daysAgo === 0 ? dateStr
      : daysAgo === 1 ? `${dateStr} (yesterday)`
      : `${dateStr} (${daysAgo} days ago)`;

    let msg = `📊 Daily Summary — ${dateLabel}\n\n`;

    if (newToday.length > 0) {
      msg += `➕ New Members: ${newToday.length} (₹${joinRevenue})\n`;
      msg += newToday.map(m => `   • ${m.name} • ${m.phone}`).join('\n') + '\n\n';
    } else {
      msg += `➕ New Members: 0\n\n`;
    }

    if (renewedToday.length > 0) {
      msg += `♻️ Renewals: ${renewedToday.length}\n`;
      if (fullRenewals.length > 0)
        msg += `   • ${fullRenewals.length} full @ ₹${config.renewal.fullAmount} = ₹${fullRenewals.length * config.renewal.fullAmount}\n`;
      if (referralRenewals.length > 0)
        msg += `   • ${referralRenewals.length} referral @ ₹${config.renewal.referralAmount} = ₹${referralRenewals.length * config.renewal.referralAmount}\n`;
      msg += '\n';
    } else {
      msg += `♻️ Renewals: 0\n\n`;
    }

    msg += `💰 Today's Revenue: ₹${totalRevenue}\n`;
    if (joinRevenue > 0 || renewalRevenue > 0) {
      msg += `   (Joins ₹${joinRevenue} + Renewals ₹${renewalRevenue})\n`;
      msg += `   Per person: ₹${Math.round(totalRevenue / 2)}\n\n`;
    } else {
      msg += '\n';
    }

    msg += `❌ Removals: ${removedToday.length}\n`;
    msg += `⚠️ Overdue (6+ days): ${overdue.length}\n`;
    msg += `👥 Total Active: ${totalActive}`;

    return msg;
  }

  function handleStats() {
    const all = store.getAll();
    const active = all.filter(m => m.status === 'ACTIVE').length;
    const removed = all.filter(m => m.status === 'REMOVED').length;
    const skipped = all.filter(m => m.status === 'SKIPPED').length;
    const overdue = all.filter(m => {
      const days = daysFromToday(m.billingDate);
      return m.status === 'ACTIVE' && days !== null && days < 0;
    }).length;
    const dueToday = all.filter(m => m.status === 'ACTIVE' && daysFromToday(m.billingDate) === 0).length;

    return `📊 STATS\n\n👥 Active: ${active}\n❌ Removed: ${removed}\n⏭️ Skipped: ${skipped}\n⚠️ Overdue: ${overdue}\n📅 Due today: ${dueToday}\n📁 Total rows in sheet: ${all.length} (+1 header = ${all.length + 1} Excel rows)`;
  }

  function handleRevenue() {
    const all = store.getAll();
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());

    // Renewals: only count entries where the "renewed" command was actually run this month.
    // Uses lastRenewed (set exclusively by handleRenewed) so kicks/skips/other ops don't pollute the count.
    const renewedThisMonth = all.filter(m => m.lastRenewed && isUpdatedThisMonth(m.lastRenewed));
    const fullRenewals = renewedThisMonth.filter(m => m.paidLast === config.renewal.fullAmount);
    const referralRenewals = renewedThisMonth.filter(m => m.paidLast === config.renewal.referralAmount);
    const renewalRevenue =
      fullRenewals.length * config.renewal.fullAmount +
      referralRenewals.length * config.renewal.referralAmount;

    // New joins this month (by joinDate)
    const joinsThisMonth = all.filter(m => {
      if (!m.joinDate || m.joinDate.length < 10) return false;
      return m.joinDate.slice(3, 5) === mm && m.joinDate.slice(6, 10) === yyyy;
    });
    const joinRevenue = joinsThisMonth.length * config.joining.fee;

    const totalRevenue = renewalRevenue + joinRevenue;
    const perPerson = Math.round(totalRevenue / 2);
    const monthName = now.toLocaleString('en-IN', { month: 'long' });

    let msg = `💰 Revenue — ${monthName} ${yyyy}\n\n`;
    msg += `Total: ₹${totalRevenue}\n`;
    msg += `Per person: ₹${perPerson}\n\n`;
    msg += `♻️ Renewals: ${renewedThisMonth.length} (₹${renewalRevenue})\n`;
    if (fullRenewals.length > 0)
      msg += `   • ${fullRenewals.length} full @ ₹${config.renewal.fullAmount}\n`;
    if (referralRenewals.length > 0)
      msg += `   • ${referralRenewals.length} referral @ ₹${config.renewal.referralAmount}\n`;
    if (joinsThisMonth.length > 0)
      msg += `\n➕ New joins: ${joinsThisMonth.length} (₹${joinRevenue})`;

    return msg;
  }

  function handleGroups() {
    const lines = config.paidGroups.map((g, i) => `${i + 1}. ${g}`).join('\n');
    return `👥 PAID GROUPS (${config.paidGroups.length}):\n\n${lines}`;
  }

  function handlePing(sock) {
    const uptimeMs = Date.now() - botStartTime;
    const uptime = Math.floor(uptimeMs / 60000);
    const connected = !!sock?.user;
    return `🟢 Bot ${config.botName} is alive\nUptime: ${uptime} minutes\nWhatsApp: ${connected ? '✅ Connected' : '❌ Disconnected'}`;
  }

  function handleHelp() {
    return `📋 BOT COMMANDS

👤 MEMBERS
• add [Name] [phone]
• add [Name] [phone] [day 1-31]
• rejoin [phone] / [phone] [day]
• kick [phone]
• skip [phone] [reason]
• unskip [phone]
• approve [phone]
• approveall
• sendlinks [phone]
• links [phone]
• groupcheck [phone]

💰 RENEWALS
• renewed [phone]  →  ₹${config.renewal.fullAmount}
• renewed [phone] 45  →  ₹${config.renewal.referralAmount}
• renewed [phone] [day 1-31]
• renewed [phone] [day] 45
• due / due tomorrow
• overdue / pending

🔍 LOOKUP
• find [phone or name]
• status [phone]

📊 REPORTS
• summary / summary 1 / summary 2
• stats / revenue / groups / ping

⚡ OVERDUE ACTIONS
Send "overdue" first, then reply:
• R[n] — Remove member
• S[n] — Skip member
• W[n] — Send warning
Example: R1 R2 S3`;
  }

  return { handleMorningDigest, handleSummary, handleStats, handleRevenue, handleGroups, handlePing, handleHelp };
}
