import fs from 'fs';
import path from 'path';
import { daysFromToday, todayStr, getReferralsInBillingPeriod, parseDate, formatDate, normalizePhone } from '../globalConfig.js';

// Unified date extractor → always returns "DD-MM-YYYY" or null.
// Handles: DD-MM-YYYY, DD-MM-YYYY HH:MM, ISO YYYY-MM-DDTHH:...
function toDDMMYYYY(dateStr) {
  if (!dateStr || dateStr.length < 10) return null;
  if (dateStr[2] === '-') return dateStr.slice(0, 10);
  const [yyyy, mm, dd] = dateStr.slice(0, 10).split('-');
  if (!yyyy || !mm || !dd) return null;
  return `${dd}-${mm}-${yyyy}`;
}

// True when dateStr falls in the given mm/yyyy ("01"-"12" / "2026")
function inMonth(dateStr, mm, yyyy) {
  if (!dateStr || dateStr.length < 7) return false;
  if (dateStr[2] === '-') return dateStr.slice(3, 5) === mm && dateStr.slice(6, 10) === yyyy;
  return dateStr.startsWith(`${yyyy}-${mm}`);
}

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

    const warnDays = config.overdue?.autoReminderDays ?? 5;
    const warnToday = overdue.filter(m => Math.abs(daysFromToday(m.billingDate) || 0) >= warnDays);
    const totalActive = all.filter(m => m.status === 'ACTIVE').length;
    const totalSkipped = all.filter(m => m.status === 'SKIPPED').length;

    const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

    let msg = `☀️ Morning Digest — ${dateStr}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `📅 DUE TODAY: ${dueToday.length} member${dueToday.length !== 1 ? 's' : ''}\n`;
    if (dueToday.length > 0) {
      msg += dueToday.map(m => {
        const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
        const refTag = refs >= 2 ? '  🎉 2 refs → auto-renew' : refs === 1 ? '  💰 1 ref → ₹45' : '';
        return `   • ${m.name}  ${m.phone}${refTag}`;
      }).join('\n') + '\n';
    }

    msg += `\n⚠️ OVERDUE: ${overdue.length} member${overdue.length !== 1 ? 's' : ''}\n`;
    if (overdue.length > 0) {
      const show = overdue.slice(0, 8);
      msg += show.map(m => `   • ${m.name}  (${Math.abs(daysFromToday(m.billingDate))}d overdue)`).join('\n');
      if (overdue.length > 8) msg += `\n   ... +${overdue.length - 8} more`;
      msg += '\n';
    }

    if (warnToday.length > 0) {
      msg += `\n🚨 AUTO-WARN TODAY (${warnDays}+ days): ${warnToday.length} member${warnToday.length !== 1 ? 's' : ''}\n`;
      msg += warnToday.map(m => `   • ${m.name}  (${Math.abs(daysFromToday(m.billingDate))}d)`).join('\n') + '\n';
    }

    msg += `\n📊 Active: ${totalActive}  |  Overdue: ${overdue.length}  |  Due today: ${dueToday.length}  |  Skipped: ${totalSkipped}`;

    // Trial removal schedule (if active)
    try {
      const stateFile = path.join(config.botDir, 'trial-state.json');
      if (fs.existsSync(stateFile)) {
        const trialState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (trialState?.active) {
          const pending = trialState.batches.filter(b => !b.done);
          if (pending.length > 0) {
            msg += `\n\n🔄 Trial Removal — ${pending.length} batch${pending.length !== 1 ? 'es' : ''} today:\n`;
            msg += pending.map(b => {
              const d = new Date(b.scheduledAt);
              return `   • ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST`;
            }).join('\n');
          }
        }
      }
    } catch (_) {}

    return msg;
  }

  async function handleSummary(args = []) {
    await store.refresh();
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
      isUpdatedOn(m.lastUpdated, targetDateStr) && m.renewals > 0
      && m.joinDate !== targetDateStr && Number(m.paidLast) !== 0
    ).sort((a, b) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''));
    const autoRenewedToday = all.filter(m =>
      isUpdatedOn(m.lastUpdated, targetDateStr) && m.renewals > 0
      && m.joinDate !== targetDateStr && Number(m.paidLast) === 0
    ).sort((a, b) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''));
    const removedToday = all.filter(m =>
      m.status === 'REMOVED' && isUpdatedOn(m.lastUpdated, targetDateStr)
    );
    const skippedToday = all.filter(m =>
      m.status === 'SKIPPED' && isUpdatedOn(m.lastUpdated, targetDateStr)
    );
    const consolidatedDays = config.overdue?.consolidatedListDays ?? 7;
    const overdue = all.filter(m => {
      const days = daysFromToday(m.billingDate);
      return m.status === 'ACTIVE' && days !== null && days <= -consolidatedDays;
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

    const totalRenewals = renewedToday.length + autoRenewedToday.length;
    if (totalRenewals > 0) {
      msg += `♻️ Renewals: ${totalRenewals}\n`;
      if (fullRenewals.length > 0) {
        msg += `   • ${fullRenewals.length} full @ ₹${config.renewal.fullAmount} = ₹${fullRenewals.length * config.renewal.fullAmount}\n`;
        msg += fullRenewals.map(m => `      ${m.name} • ${m.phone}`).join('\n') + '\n';
      }
      if (referralRenewals.length > 0) {
        msg += `   • ${referralRenewals.length} referral @ ₹${config.renewal.referralAmount} = ₹${referralRenewals.length * config.renewal.referralAmount}\n`;
        msg += referralRenewals.map(m => `      ${m.name} • ${m.phone}`).join('\n') + '\n';
      }
      if (autoRenewedToday.length > 0) {
        msg += `   • ${autoRenewedToday.length} ref-free @ ₹0 (2 referrals)\n`;
        msg += autoRenewedToday.map(m => `      ${m.name} • ${m.phone}`).join('\n') + '\n';
      }
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

    if (removedToday.length > 0) {
      msg += `❌ Removals: ${removedToday.length}\n`;
      msg += removedToday.map(m => `   • ${m.name} • ${m.phone}`).join('\n') + '\n';
    } else {
      msg += `❌ Removals: 0\n`;
    }

    if (skippedToday.length > 0) {
      msg += `⏭️ Skipped: ${skippedToday.length}\n`;
      msg += skippedToday.map(m => `   • ${m.name} • ${m.phone}${m.skipReason ? ` (${m.skipReason})` : ''}`).join('\n') + '\n';
    } else {
      msg += `⏭️ Skipped: 0\n`;
    }

    msg += `⚠️ Overdue (${consolidatedDays}+ days): ${overdue.length}\n`;
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

  function handleRemovedList() {
    const all = store.getAll();
    const removed = all
      .filter(m => m.status === 'REMOVED')
      .sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));

    if (removed.length === 0) return '✅ No removed members.';

    const show = removed.slice(0, 30);
    const lines = show.map((m, i) => `${i + 1}. ${m.name} • ${m.phone}`).join('\n');
    let msg = `❌ REMOVED MEMBERS (${removed.length} total — latest first):\n\n${lines}`;
    if (removed.length > 30) msg += `\n... +${removed.length - 30} more`;
    msg += `\n\nTo rejoin: rejoin [phone]`;
    return msg;
  }

  function handleSkippedList() {
    const all = store.getAll();
    const skipped = all.filter(m => m.status === 'SKIPPED');

    if (skipped.length === 0) return '✅ No skipped members.';

    const lines = skipped.map((m, i) =>
      `${i + 1}. ${m.name} • ${m.phone}${m.skipReason ? `\n   Reason: ${m.skipReason}` : ''}`
    ).join('\n');
    return `⏭️ SKIPPED MEMBERS (${skipped.length}):\n\n${lines}\n\nTo unskip: unskip [phone]`;
  }

  function handleHelp() {
    return `📋 BOT COMMANDS

👤 MEMBERS
• add [Name] [phone] / [day] / ref [refPhone]
• add [Name] [phone] ref [refPhone] prev  →  credit ref to referrer's PREVIOUS billing period
• addsilent [Name] [phone]  →  sheet only, no links
• rejoin [phone] / [phone] [day]
• kick [phone]
• skip [phone] [reason]  /  unskip [phone]
• approve / approveall  /  rejectall
• sendlinks [phone]  /  links [phone]
• groupcheck [phone]

💰 RENEWALS
• renewed [phone]  →  ₹${config.renewal.fullAmount}
• renewed [phone] force  →  override same-month block
• renewed [phone] 45  →  ₹${config.renewal.referralAmount}
• renewed [phone] [day]  /  [day] 45
• remind [phone]  →  send reminder + QR manually
• due / due tomorrow
• upcoming [days]  →  who's due in next N days (default 7)
• overdue / pending

👥 REFERRALS
• [phone] ref [refPhone]
• [phone] ref [refPhone] prev  →  credit ref to referrer's PREVIOUS billing period
• refs [phone]

🔍 LOOKUP
• find [phone or name]  →  full profile + ref count
• status [phone]

📊 REPORTS
• summary / summary 1 / summary 2
• weekly  →  last 7 days
• monthly / monthly [month] / monthly [month] [year]
• stats / revenue / groups / ping
• removed  /  skipped

📈 BUSINESS ANALYTICS
• growth    →  6-month member growth trend
• trend     →  6-month revenue history
• forecast  →  projected revenue this month
• churn     →  this month's net member change
• collection →  monthly collection rate %
• toprefs   →  all-time referral leaderboard
• loyal     →  top members by renewals
• norenew   →  never-renewed (churn risk) list
• tenure    →  avg member lifetime

⚡ OVERDUE ACTIONS
Send "overdue" first, then reply:
• R[n] — Remove  /  S[n] — Skip  /  W[n] — Warn
Example: R1 R2 S3

🚫 BULK REMOVAL (7+ days overdue)
• removal  /  warnall  /  kickall  /  stop kickall

🔁 TRIAL GROUP
• start removal  /  stop removal

🔧 TOOLS
• audit  →  data quality check`;
  }

  // ─── UPCOMING ───────────────────────────────────────────────────────────────
  function handleUpcoming(args) {
    const days = Math.min(parseInt(args[0]) || 7, 60);
    const all = store.getAll();
    const active = store.getActive();
    const list = active
      .filter(m => { const d = daysFromToday(m.billingDate); return d !== null && d > 0 && d <= days; })
      .sort((a, b) => (daysFromToday(a.billingDate) || 0) - (daysFromToday(b.billingDate) || 0));

    if (list.length === 0) return `📅 No members due in the next ${days} days.`;

    const lines = list.map(m => {
      const d = daysFromToday(m.billingDate);
      const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
      const tag = refs >= 2 ? ' 🎉 auto-renew' : refs === 1 ? ` 💰 ₹${config.renewal.referralAmount}` : ` ₹${config.renewal.fullAmount}`;
      return `• ${m.name}  ${m.phone}  ${d}d${tag}`;
    }).join('\n');

    return `📅 DUE IN NEXT ${days} DAYS (${list.length}):\n\n${lines}`;
  }

  // ─── TOP REFERRERS ───────────────────────────────────────────────────────────
  function handleTopRefs() {
    const all = store.getAll();
    const counts = {};
    for (const m of all) {
      if (!m.reference) continue;
      const ref = normalizePhone(m.reference);
      if (ref.length !== 10) continue;
      counts[ref] = (counts[ref] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (sorted.length === 0) return '📊 No referrals recorded yet.';

    const lines = sorted.map(([phone, count], i) => {
      const member = store.findByPhone(phone);
      const name = member ? member.name : phone;
      const status = member && member.status !== 'ACTIVE' ? ` (${member.status})` : '';
      return `${i + 1}. ${name}${status}  ${phone}  — ${count} referral${count !== 1 ? 's' : ''}`;
    }).join('\n');

    return `🏆 TOP REFERRERS (all-time):\n\n${lines}`;
  }

  // ─── LOYAL MEMBERS ───────────────────────────────────────────────────────────
  function handleLoyal(args) {
    const n = Math.min(parseInt(args[0]) || 10, 30);
    const active = store.getActive();
    const sorted = [...active]
      .filter(m => (m.renewals || 0) > 0)
      .sort((a, b) => (b.renewals || 0) - (a.renewals || 0))
      .slice(0, n);

    if (sorted.length === 0) return '📊 No members have renewed yet.';

    const lines = sorted.map((m, i) =>
      `${i + 1}. ${m.name}  ${m.phone}  — ${m.renewals} renewal${m.renewals !== 1 ? 's' : ''}`
    ).join('\n');

    return `💎 TOP ${n} LOYAL MEMBERS (by renewals):\n\n${lines}`;
  }

  // ─── GROWTH ──────────────────────────────────────────────────────────────────
  function handleGrowth() {
    const all = store.getAll();
    const now = new Date();
    const rows = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = String(d.getFullYear());
      const label = d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });

      const joins    = all.filter(m => inMonth(m.joinDate, mm, yyyy)).length;
      const removals = all.filter(m => m.status === 'REMOVED' && inMonth(m.lastUpdated, mm, yyyy)).length;
      const net = joins - removals;
      const arrow = net > 0 ? '↑' : net < 0 ? '↓' : '→';
      rows.push(`${label.padEnd(12)} +${joins} joined  -${removals} removed  ${arrow} net ${net >= 0 ? '+' : ''}${net}`);
    }

    return `📈 MEMBER GROWTH (6 months):\n\n${rows.join('\n')}`;
  }

  // ─── FORECAST ────────────────────────────────────────────────────────────────
  function handleForecast() {
    const all = store.getAll();
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const monthName = now.toLocaleString('en-IN', { month: 'long' });

    const alreadyRenewed = all.filter(m => m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy));
    const collected = alreadyRenewed.reduce((s, m) => s + (Number(m.paidLast) || 0), 0);

    const pending = all.filter(m => {
      if (m.status !== 'ACTIVE') return false;
      if (!inMonth(m.billingDate, mm, yyyy)) return false;
      return !(m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy));
    });

    let estimated = 0, autoCount = 0, halfCount = 0, fullCount = 0;
    for (const m of pending) {
      const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all).length;
      if (refs >= 2)       { autoCount++; }
      else if (refs === 1) { halfCount++; estimated += config.renewal.referralAmount; }
      else                 { fullCount++; estimated += config.renewal.fullAmount; }
    }

    const total = collected + estimated;
    let msg = `🔮 FORECAST — ${monthName} ${yyyy}\n\n`;
    msg += `✅ Collected so far: ₹${collected}  (${alreadyRenewed.length} renewed)\n`;
    msg += `⏳ Still pending: ${pending.length} members\n`;
    if (pending.length > 0) {
      if (fullCount)  msg += `   • ${fullCount} × ₹${config.renewal.fullAmount} = ₹${fullCount * config.renewal.fullAmount}\n`;
      if (halfCount)  msg += `   • ${halfCount} × ₹${config.renewal.referralAmount} = ₹${halfCount * config.renewal.referralAmount}\n`;
      if (autoCount)  msg += `   • ${autoCount} × ₹0 (2 refs)\n`;
      msg += `   Estimated: ₹${estimated}\n`;
    }
    msg += `\n💰 Total expected: ₹${total}`;
    msg += `\n   Per person: ₹${Math.round(total / 2)}`;
    return msg;
  }

  // ─── TREND ───────────────────────────────────────────────────────────────────
  function handleTrend() {
    const all = store.getAll();
    const now = new Date();
    const rows = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = String(d.getFullYear());
      const label = d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });

      const renewed  = all.filter(m => m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy));
      const joins    = all.filter(m => inMonth(m.joinDate, mm, yyyy));
      const revenue  = renewed.reduce((s, m) => s + (Number(m.paidLast) || 0), 0)
                     + joins.length * config.joining.fee;

      rows.push(`${label.padEnd(12)} ₹${String(revenue).padStart(5)}  (${renewed.length} renewals + ${joins.length} joins)`);
    }

    return `📊 REVENUE TREND (6 months):\n\n${rows.join('\n')}`;
  }

  // ─── CHURN ───────────────────────────────────────────────────────────────────
  function handleChurn() {
    const all = store.getAll();
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const monthName = now.toLocaleString('en-IN', { month: 'long' });

    const joins    = all.filter(m => inMonth(m.joinDate, mm, yyyy));
    const removals = all.filter(m => m.status === 'REMOVED' && inMonth(m.lastUpdated, mm, yyyy));
    const net = joins.length - removals.length;
    const indicator = net > 0 ? '📈 growing' : net < 0 ? '📉 shrinking' : '→ stable';

    let msg = `📉 CHURN — ${monthName} ${yyyy}\n\n`;
    msg += `➕ Joins:    ${joins.length}\n`;
    msg += `❌ Removals: ${removals.length}\n`;
    msg += `📊 Net: ${net >= 0 ? '+' : ''}${net}  ${indicator}`;

    if (removals.length > 0) {
      const names = removals.slice(0, 5).map(m => `   • ${m.name}  ${m.phone}`).join('\n');
      msg += `\n\nRemoved this month:\n${names}`;
      if (removals.length > 5) msg += `\n   ... +${removals.length - 5} more`;
    }
    return msg;
  }

  // ─── NO RENEW ────────────────────────────────────────────────────────────────
  function handleNoRenew() {
    const active = store.getActive();
    const list = active
      .filter(m => !m.renewals || Number(m.renewals) === 0)
      .sort((a, b) => (daysFromToday(a.billingDate) || 999) - (daysFromToday(b.billingDate) || 999));

    if (list.length === 0) return '✅ All active members have renewed at least once.';

    const lines = list.map(m => {
      const d = daysFromToday(m.billingDate);
      const dStr = d === null ? 'no date' : d === 0 ? '⚠️ DUE TODAY' : d > 0 ? `due in ${d}d` : `⚠️ ${Math.abs(d)}d overdue`;
      return `• ${m.name}  ${m.phone}  joined ${m.joinDate}  ${dStr}`;
    }).join('\n');

    return `⚠️ NEVER RENEWED — ${list.length} member${list.length !== 1 ? 's' : ''} (highest churn risk):\n\n${lines}`;
  }

  // ─── COLLECTION ──────────────────────────────────────────────────────────────
  function handleCollection() {
    const all = store.getAll();
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const monthName = now.toLocaleString('en-IN', { month: 'long' });

    const dueThisMonth = all.filter(m => inMonth(m.billingDate, mm, yyyy));
    const renewedSet   = dueThisMonth.filter(m => m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy));
    const notRenewed   = dueThisMonth.filter(m => !(m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy)));

    const activePending  = notRenewed.filter(m => m.status === 'ACTIVE');
    const removedUnpaid  = notRenewed.filter(m => m.status === 'REMOVED');
    const skippedUnpaid  = notRenewed.filter(m => m.status === 'SKIPPED');

    const rate = dueThisMonth.length > 0
      ? Math.round((renewedSet.length / dueThisMonth.length) * 100) : 0;
    const collected    = renewedSet.reduce((s, m) => s + (Number(m.paidLast) || 0), 0);
    const outstanding  = activePending.length * config.renewal.fullAmount;

    let msg = `📊 COLLECTION RATE — ${monthName} ${yyyy}\n\n`;
    msg += `Due this month:    ${dueThisMonth.length}\n`;
    msg += `✅ Renewed:        ${renewedSet.length}  (${rate}%)\n`;
    msg += `⏳ Active pending: ${activePending.length}\n`;
    if (removedUnpaid.length)  msg += `❌ Removed unpaid: ${removedUnpaid.length}\n`;
    if (skippedUnpaid.length)  msg += `⏭️ Skipped:        ${skippedUnpaid.length}\n`;
    msg += `\n💰 Collected: ₹${collected}`;
    msg += `\n📋 Outstanding (est.): ₹${outstanding}`;
    return msg;
  }

  // ─── TENURE ──────────────────────────────────────────────────────────────────
  function handleTenure() {
    const all = store.getAll();
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const active  = all.filter(m => m.status === 'ACTIVE'  && m.joinDate);
    const removed = all.filter(m => m.status === 'REMOVED' && m.joinDate && m.lastUpdated);

    const daysSince = (dateStr) => {
      const d = parseDate(dateStr);
      if (!d) return null;
      d.setHours(0, 0, 0, 0);
      return Math.max(0, Math.round((now - d) / 86400000));
    };

    const activeDays = active.map(m => daysSince(m.joinDate)).filter(d => d !== null);

    const removedDays = removed.map(m => {
      const join = parseDate(m.joinDate);
      if (!join) return null;
      const removedDateStr = toDDMMYYYY(m.lastUpdated);
      if (!removedDateStr) return null;
      const removedD = parseDate(removedDateStr);
      if (!removedD) return null;
      join.setHours(0, 0, 0, 0); removedD.setHours(0, 0, 0, 0);
      return Math.max(0, Math.round((removedD - join) / 86400000));
    }).filter(d => d !== null);

    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
    const toMonths = d => (d / 30).toFixed(1);

    const avgA = avg(activeDays);
    const avgR = avg(removedDays);

    let msg = `⏱️ MEMBER TENURE\n\n`;
    msg += `👥 Active (${active.length} members):\n`;
    msg += `   Avg time in group: ${toMonths(avgA)} months  (${avgA} days)\n\n`;
    msg += `❌ Removed (${removed.length} members):\n`;
    msg += `   Avg before leaving: ${toMonths(avgR)} months  (${avgR} days)`;
    return msg;
  }

  // ─── WEEKLY ──────────────────────────────────────────────────────────────────
  function handleWeekly() {
    const all = store.getAll();
    const now = new Date();

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      last7.push(formatDate(d));
    }
    const last7Set = new Set(last7);

    const inLast7 = (dateStr) => last7Set.has(toDDMMYYYY(dateStr));

    const newThisWeek     = all.filter(m => last7Set.has(m.joinDate));
    const renewedThisWeek = all.filter(m => m.lastRenewed && last7Set.has(toDDMMYYYY(m.lastRenewed)) && Number(m.renewals) > 0 && !last7Set.has(m.joinDate));
    const autoRenewed     = renewedThisWeek.filter(m => Number(m.paidLast) === 0);
    const paidRenewed     = renewedThisWeek.filter(m => Number(m.paidLast) > 0);
    const removedThisWeek = all.filter(m => m.status === 'REMOVED' && inLast7(m.lastUpdated));

    const joinRevenue    = newThisWeek.length * config.joining.fee;
    const renewalRevenue = paidRenewed.reduce((s, m) => s + (Number(m.paidLast) || 0), 0);
    const totalRevenue   = joinRevenue + renewalRevenue;
    const net = newThisWeek.length - removedThisWeek.length;

    let msg = `📅 WEEKLY SUMMARY (${last7[0]} → ${last7[6]})\n\n`;
    msg += `➕ New Members: ${newThisWeek.length}\n`;
    msg += `♻️ Renewals: ${paidRenewed.length} paid + ${autoRenewed.length} auto-renew\n`;
    msg += `❌ Removals: ${removedThisWeek.length}\n`;
    msg += `📊 Net change: ${net >= 0 ? '+' : ''}${net}\n`;
    msg += `\n💰 Revenue: ₹${totalRevenue}`;
    if (joinRevenue > 0 || renewalRevenue > 0)
      msg += `\n   Joins ₹${joinRevenue} + Renewals ₹${renewalRevenue}`;
    return msg;
  }

  // ─── MONTHLY SUMMARY ─────────────────────────────────────────────────────────
  function handleMonthly(args = []) {
    const all = store.getAll();
    const now = new Date();
    let targetMonth, targetYear;

    if (args.length === 0) {
      targetMonth = now.getMonth() + 1;
      targetYear  = now.getFullYear();
    } else {
      const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const arg0 = String(args[0]).toLowerCase();
      const byName = MONTH_NAMES.findIndex(m => m.startsWith(arg0));

      if (byName !== -1) {
        targetMonth = byName + 1;
        targetYear  = (args[1] && /^\d{4}$/.test(args[1])) ? Number(args[1]) : now.getFullYear();
        if (targetYear === now.getFullYear() && targetMonth > now.getMonth() + 1) targetYear--;
      } else if (/^\d{1,2}$/.test(arg0)) {
        targetMonth = Number(arg0);
        targetYear  = (args[1] && /^\d{4}$/.test(args[1])) ? Number(args[1]) : now.getFullYear();
        if (targetYear === now.getFullYear() && targetMonth > now.getMonth() + 1) targetYear--;
      } else if (/^\d{2}-\d{4}$/.test(arg0)) {
        const [mmS, yyyyS] = arg0.split('-');
        targetMonth = Number(mmS); targetYear = Number(yyyyS);
      } else {
        return '❌ Format: monthly  or  monthly april  or  monthly 4  or  monthly 04-2025  or  monthly april 2025';
      }
    }

    const mm   = String(targetMonth).padStart(2, '0');
    const yyyy = String(targetYear);
    const monthLabel = new Date(targetYear, targetMonth - 1, 1)
      .toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const isIn = (dateStr) => inMonth(dateStr, mm, yyyy);

    const newMembers     = all.filter(m => isIn(m.joinDate));
    const allRenewed     = all.filter(m => m.lastRenewed && isIn(m.lastRenewed) && Number(m.renewals) > 0 && !isIn(m.joinDate));
    const autoRenewed    = allRenewed.filter(m => Number(m.paidLast) === 0);
    const paidRenewed    = allRenewed.filter(m => Number(m.paidLast) > 0);
    const fullRenewals   = paidRenewed.filter(m => Number(m.paidLast) === config.renewal.fullAmount);
    const halfRenewals   = paidRenewed.filter(m => Number(m.paidLast) === config.renewal.referralAmount);
    const removedMembers = all.filter(m => m.status === 'REMOVED' && isIn(m.lastUpdated));
    const skippedMembers = all.filter(m => m.status === 'SKIPPED' && isIn(m.lastUpdated));

    const joinRevenue    = newMembers.length * config.joining.fee;
    const renewRevenue   = fullRenewals.length * config.renewal.fullAmount
                         + halfRenewals.length * config.renewal.referralAmount;
    const totalRevenue   = joinRevenue + renewRevenue;
    const net = newMembers.length - removedMembers.length;

    let msg = `📅 MONTHLY SUMMARY — ${monthLabel}\n\n`;

    msg += `➕ New Members: ${newMembers.length}`;
    if (newMembers.length > 0) msg += '\n' + newMembers.map(m => `   • ${m.name} • ${m.phone}`).join('\n');
    msg += '\n\n';

    msg += `♻️ Renewals: ${allRenewed.length}\n`;
    if (fullRenewals.length)  msg += `   • ${fullRenewals.length} full @ ₹${config.renewal.fullAmount} = ₹${fullRenewals.length * config.renewal.fullAmount}\n`;
    if (halfRenewals.length)  msg += `   • ${halfRenewals.length} referral @ ₹${config.renewal.referralAmount} = ₹${halfRenewals.length * config.renewal.referralAmount}\n`;
    if (autoRenewed.length)   msg += `   • ${autoRenewed.length} ref-free @ ₹0 (2 refs)\n`;
    msg += '\n';

    msg += `❌ Removals: ${removedMembers.length}`;
    if (removedMembers.length > 0) msg += '\n' + removedMembers.map(m => `   • ${m.name} • ${m.phone}`).join('\n');
    msg += '\n';

    if (skippedMembers.length > 0)
      msg += `⏭️ Skipped: ${skippedMembers.length}\n`;

    msg += `\n💰 Revenue: ₹${totalRevenue}`;
    if (totalRevenue > 0) msg += `\n   Joins ₹${joinRevenue} + Renewals ₹${renewRevenue}\n   Per person: ₹${Math.round(totalRevenue / 2)}`;
    msg += `\n📊 Net change: ${net >= 0 ? '+' : ''}${net} members`;

    return msg;
  }

  // ─── AUDIT ───────────────────────────────────────────────────────────────────
  function handleAudit() {
    const all = store.getAll();
    const issues = [];
    const seen = new Set();

    for (const m of all) {
      const norm = normalizePhone(m.phone || '');

      if (!m.name || m.name.trim().length < 2)
        issues.push(`❌ Missing name: row with phone "${m.phone}"`);

      if (norm.length !== 10)
        issues.push(`❌ Invalid phone: ${m.name} — "${m.phone}"`);

      if (norm.length === 10) {
        if (seen.has(norm)) issues.push(`❗ Duplicate phone: ${norm} (${m.name})`);
        seen.add(norm);
      }

      if (m.status === 'ACTIVE' && !m.billingDate)
        issues.push(`⚠️ No billing date: ${m.name} (${m.phone})`);

      if (m.status === 'ACTIVE' && m.billingDate) {
        const d = daysFromToday(m.billingDate);
        if (d !== null && d < -180)
          issues.push(`⚠️ Stale billing (${Math.abs(d)}d overdue): ${m.name} (${m.phone})`);
      }
    }

    if (issues.length === 0)
      return `✅ AUDIT CLEAN — ${all.length} records checked, no issues found.`;
    return `🔍 AUDIT — ${all.length} records, ${issues.length} issue(s) found:\n\n${issues.join('\n')}`;
  }

  return { handleMorningDigest, handleSummary, handleStats, handleRevenue, handleGroups, handleRemovedList, handleSkippedList, handlePing, handleHelp, handleUpcoming, handleTopRefs, handleLoyal, handleGrowth, handleForecast, handleTrend, handleChurn, handleNoRenew, handleCollection, handleTenure, handleWeekly, handleMonthly, handleAudit };
}
