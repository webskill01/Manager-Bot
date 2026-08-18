import fs from 'fs';
import path from 'path';
import { daysFromToday, todayStr, getReferralsInBillingPeriod, parseDate, formatDate, normalizePhone, formatSplit, isPaidJoin, isTracker, isCallDue, needsFollowUp } from '../globalConfig.js';

// Silent/existing-member adds (addsilent) store paidLast = 0 and must never be counted as
// a new member or as join revenue. Real joins (add/rejoin) store the joining fee.
const isPaidJoinRow = m => Number(m.paidLast) !== 0;

// A genuine new join always has its billing date set a cycle AHEAD of the join date — the `add`
// command pushes billing to the next month, so billing > join always holds for a real join (and
// keeps holding, since renewals only move billing further forward). A row where billing <= join is
// an EXISTING member whose joinDate was hand-edited in the sheet to a recent/today's date (their
// billing still reflects the real current cycle). Such rows must never be counted as new joins.
const hasForwardBilling = m => {
  const b = parseDate(m.billingDate), j = parseDate(m.joinDate);
  return !!b && !!j && b.getTime() > j.getTime();
};

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

  // The `digest` command. Was a 6 AM cron that DM'd every admin — now pulled on demand,
  // so it refreshes the sheet first and carries the auto-renew and catch-up lines that
  // used to arrive as separate broadcasts.
  async function handleMorningDigest() {
    await store.refresh();
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
        const refTag = refs >= 2 ? '  🎉 2 refs → auto-renew' : refs === 1 ? `  💰 1 ref → ₹${config.renewal.referralAmount}` : '';
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

    // Today's 2-ref free renewals — replaces the old post-batch admin broadcast.
    try {
      const rState = JSON.parse(fs.readFileSync(path.join(config.botDir, 'reminder-state.json'), 'utf8'));
      const free = rState?.autoRenewedToday || [];
      if (free.length > 0) {
        msg += `\n\n🎁 AUTO-RENEWED TODAY (2 refs → free): ${free.length}\n`;
        msg += free.map(a => `   • ${a.name}  ${a.phone}`).join('\n');
      }
    } catch (_) {}

    // Catch-up cycle progress (if one is running)
    try {
      const cState = JSON.parse(fs.readFileSync(path.join(config.botDir, 'catchup-state.json'), 'utf8'));
      if (cState?.cohort) {
        msg += `\n\n📣 Catch-up running — stage ${Math.min(cState.stage + 1, 3)}/3, ` +
          `${cState.cohort.length} in cohort, delayed until ${cState.delayUntil}`;
      }
    } catch (_) {}

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

    // Tracker profile: the same daily money view as a full bot, minus the renewal machinery —
    // these operators collect a joining fee and nothing else. Call activity is deliberately
    // NOT here; `log` owns that, so the daily summary stays a money report.
    if (isTracker(config)) {
      const on = d => d && d.slice(0, 10) === targetDateStr;
      const joinedToday = all.filter(m => on(m.joinDate));
      const joinRevenue = joinedToday.filter(isPaidJoinRow).length * config.joining.fee;
      const removedOnDay = all.filter(m => m.status === 'REMOVED' && isUpdatedOn(m.lastUpdated, targetDateStr));
      const skippedOnDay = all.filter(m => m.status === 'SKIPPED' && isUpdatedOn(m.lastUpdated, targetDateStr));
      const inGroups = all.filter(m => !['REMOVED', 'SKIPPED'].includes(m.status)).length;
      const label = daysAgo === 0 ? 'Today'
        : daysAgo === 1 ? `${targetDateStr} (yesterday)`
        : `${targetDateStr} (${daysAgo} days ago)`;

      let msg = `📊 Daily Summary — ${label}\n\n`;

      if (joinedToday.length > 0) {
        msg += `➕ New Members: ${joinedToday.length} (₹${joinRevenue})\n`;
        msg += joinedToday.map(m => `   • ${m.name} • ${m.phone}`).join('\n') + '\n\n';
      } else {
        msg += `➕ New Members: 0\n\n`;
      }

      msg += `💰 Today's Revenue: ₹${joinRevenue}\n`;
      if (joinRevenue > 0) msg += `${formatSplit(joinRevenue, config)}\n`;
      msg += '\n';

      msg += `❌ Removals: ${removedOnDay.length}\n`;
      if (removedOnDay.length > 0) {
        msg += removedOnDay.map(m => `   • ${m.name} • ${m.phone}`).join('\n') + '\n';
      }
      msg += `⏭️ Skipped: ${skippedOnDay.length}\n`;
      if (skippedOnDay.length > 0) {
        msg += skippedOnDay.map(m => `   • ${m.name} • ${m.phone}${m.skipReason ? ` (${m.skipReason})` : ''}`).join('\n') + '\n';
      }
      msg += `👥 Total in groups: ${inGroups}`;

      return msg;
    }

    // Detect renewals via lastRenewed (set ONLY by the "renewed" command / auto-renew), NOT
    // lastUpdated — lastUpdated is bumped by every write (incl. kickall's status→REMOVED), which
    // would otherwise make a previously-renewed member who was removed today wrongly appear as
    // "renewed today".
    const renewedOnTarget = m =>
      m.lastRenewed && isUpdatedOn(m.lastRenewed, targetDateStr) && m.renewals > 0;
    // A member explicitly renewed today is a RENEWAL, never a new join — even when they were also
    // added today (e.g. an existing member re-added via `add`, then `renewed`). Previously the
    // renewal filters excluded joinDate===today, so such a member fell through to "New Members".
    // Honour the explicit renewed action as the classifier and keep them out of newToday.
    const newToday = all.filter(m => isPaidJoin(m, targetDateStr) && !renewedOnTarget(m) && hasForwardBilling(m));
    const renewedToday = all.filter(m => renewedOnTarget(m) && Number(m.paidLast) !== 0)
      .sort((a, b) => (a.lastRenewed || '').localeCompare(b.lastRenewed || ''));
    const autoRenewedToday = all.filter(m => renewedOnTarget(m) && Number(m.paidLast) === 0)
      .sort((a, b) => (a.lastRenewed || '').localeCompare(b.lastRenewed || ''));
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
    // Headline count weights half-payment (referral) renewals as 0.5 and full renewals as 1.
    // Ref-free auto-renewals (₹0, earned via 2 referrals) are still LISTED below but are NOT
    // counted in this total — they bring in no revenue. e.g. 4 full + 1 referral + 3 ref-free → 4.5.
    const weightedRenewals =
      renewedToday.reduce((s, m) => s + (Number(m.paidLast) === config.renewal.referralAmount ? 0.5 : 1), 0);
    const renewalCountLabel = Number.isInteger(weightedRenewals)
      ? String(weightedRenewals) : weightedRenewals.toFixed(1);
    if (totalRenewals > 0) {
      msg += `♻️ Renewals: ${renewalCountLabel}\n`;
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
      msg += `${formatSplit(totalRevenue, config)}\n\n`;
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
    const monthLabel = now.toLocaleString('en-IN', { month: 'long' });

    // Tracker profile: revenue is joining fees only. These operators collect no renewals
    // at all — members are moved onto the app after their first month — so a renewals
    // line would always read zero and a forecast built on renewals would be a lie.
    if (isTracker(config)) {
      const joins = all.filter(m =>
        m.joinDate && m.joinDate.length >= 10
        && isPaidJoinRow(m)
        && m.joinDate.slice(3, 5) === mm && m.joinDate.slice(6, 10) === yyyy);
      const total = joins.length * config.joining.fee;
      const interested = all.filter(m => m.callResult === 'interested').length;

      return `💰 Revenue — ${monthLabel} ${yyyy}\n\n` +
        `Total: ₹${total}\n` +
        `${formatSplit(total, config, '')}\n\n` +
        `➕ New joins: ${joins.length} @ ₹${config.joining.fee}\n` +
        `   (joins only — this bot collects no renewals)\n\n` +
        `✅ Interested in the app, all time: ${interested}`;
    }

    // Renewals: only count entries where the "renewed" command was actually run this month.
    // Uses lastRenewed (set exclusively by handleRenewed) so kicks/skips/other ops don't pollute the count.
    const renewedThisMonth = all.filter(m => m.lastRenewed && isUpdatedThisMonth(m.lastRenewed));
    const fullRenewals = renewedThisMonth.filter(m => m.paidLast === config.renewal.fullAmount);
    const referralRenewals = renewedThisMonth.filter(m => m.paidLast === config.renewal.referralAmount);
    const renewalRevenue =
      fullRenewals.length * config.renewal.fullAmount +
      referralRenewals.length * config.renewal.referralAmount;

    // New joins this month (by joinDate) — excludes silent adds (paidLast 0) and anyone already
    // counted as a renewal this month, so a same-month add+renew isn't billed twice (matches monthly).
    const renewedPhonesThisMonth = new Set(renewedThisMonth.map(m => m.phone));
    const joinsThisMonth = all.filter(m => {
      if (!m.joinDate || m.joinDate.length < 10) return false;
      if (!isPaidJoinRow(m)) return false;
      if (renewedPhonesThisMonth.has(m.phone)) return false;
      if (!hasForwardBilling(m)) return false;
      return m.joinDate.slice(3, 5) === mm && m.joinDate.slice(6, 10) === yyyy;
    });
    const joinRevenue = joinsThisMonth.length * config.joining.fee;

    const totalRevenue = renewalRevenue + joinRevenue;
    const monthName = now.toLocaleString('en-IN', { month: 'long' });

    let msg = `💰 Revenue — ${monthName} ${yyyy}\n\n`;
    msg += `Total: ₹${totalRevenue}\n`;
    msg += `${formatSplit(totalRevenue, config, '')}\n\n`;
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
    // A Telegram bot has no socket by design — reporting "❌ Disconnected" would read as
    // a fault every single time. Name the transport instead.
    if (config.transport === 'telegram') {
      return `🟢 Bot ${config.botName} is alive\nUptime: ${uptime} minutes\nTransport: ✅ Telegram (no WhatsApp connection)`;
    }
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

  // Tracker bots get their own help: listing renewal commands that would be refused is
  // worse than not listing them.
  function trackerHelp() {
    const days = config.tracker?.callAfterDays ?? 30;
    const chase = config.tracker?.followUpDays ?? 3;
    return `📋 BOT COMMANDS — tracker

🔄 THE FLOW
  add → (${days} days pass) → pending → call them → log what they said
  NEW  →  CALLED (interested / not interested / no answer)

This bot only keeps the record. It never moves anyone onto the app and
never removes anyone — you do that yourself with "kick [phone]".

${config.transport === 'telegram' ? `👤 ADD A NEW PERSON
This bot has no WhatsApp connection, so the group work is yours. It writes
the sheet and hands you a one-tap link to send from your own WhatsApp.
• add [Name] [phone]  →  records as NEW + tap-to-send links & welcome
• addsilent [Name] [phone]  →  sheet only, no link prepared
• sendlinks [phone]  →  the tap-to-send link again
• links [phone]  →  just the group invite links, to paste anywhere
• rejoin [phone]  →  reactivate an old member in the sheet

Approving join requests, group membership checks and bulk group removals
are done in WhatsApp by hand — the bot will say so if you try them here.` : `👤 ADD A NEW PERSON
• add [Name] [phone]  →  sends group links + welcome, records as NEW
• addsilent [Name] [phone]  →  sheet only, no links sent
• sendlinks [phone]  →  re-send the links
• approve / approveall  →  approve pending join requests
• rejectall
• rejoin [phone]  →  add an old member back
• groupcheck [phone]  →  which groups are they in?`}

📞 CALLING
• pending  →  who to call now (${days}d in group) + who gave no answer yet
• called [phone] interested      →  logs the call + date + "interested"
• called [phone] not interested  →  logs the call + date + "not interested"
• called [phone]                 →  logs the call + date, no answer yet
     reappears in "pending" after ${chase} day(s) until you log an answer
     any of these can be re-run later to correct what you logged
• called [phone] interested [Name]  →  for someone NOT in the sheet:
     creates their row and logs the call in one go
• log  →  the full record: interested / not interested / no answer /
          not called yet.  ("calls" does the same thing)

Nobody is ever removed by these. When you want a seat back: kick [phone]
Once kicked, they vanish from "pending" and "log" for good.

🔍 LOOKUPS
• find [phone or name]  /  status [phone]
• removed  /  skipped

📊 REPORTS  (nothing is ever sent to you on a timer)
• digest  →  today at a glance
• summary / summary 1  →  the day's money: joins, revenue, split
     (call activity is NOT here — that's "log")
• revenue  →  joining fees this month + split
• weekly / monthly / growth / trend
• stats / groups / ping

🔍 GROUP AUDITS
• notinsheet  →  in a group but missing from the sheet
• leftmembers  →  in the sheet but not in any group
• stillin  →  REMOVED in the sheet but still in a group

🧹 CLEANUP
• kick [phone]  →  remove from all groups
• kickghosts / kickghosts confirm / stop kickghosts

⏱️ Timing: a person appears in "pending" ${days} days after joining.
Called with no answer logged reappears after ${chase} days.
This bot has NO scheduled jobs — it only acts when you send a command.`;
  }

  function handleHelp() {
    if (isTracker(config)) return trackerHelp();
    return `📋 BOT COMMANDS

👤 MEMBERS
• add [Name] [phone] / [day] / ref [refPhone]
• add [Name] [phone] ref [refPhone] prev  →  credit ref to referrer's PREVIOUS billing period
• addsilent [Name] [phone]  →  sheet only, no links, NOT counted as new member
• addnew [Name] [phone] / [day] / ref [refPhone]  →  sheet only, no links, counted as new member (use after sendlinks)
• rejoin [phone] / [phone] [day]
• kick [phone]
• skip [phone] [reason]  /  unskip [phone]
• delay [phone] [days]  →  hide from removal list N days (still overdue; default 1)
• delayall [days]  →  preview delaying EVERYONE overdue (billing dates unchanged)
• delayall [days] confirm  →  apply it
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

📊 REPORTS  (pull-only — nothing is sent to you on a schedule any more)
• digest  →  today's due / overdue / auto-renewed (was the 6 AM cron)
• summary / summary 1 / summary 2  →  (was the 10 PM cron)
• weekly  →  last 7 days
• monthly / monthly [month] / monthly [month] [year]
• stats / revenue / groups / ping
• removed  /  skipped
• notinsheet  →  in group but missing from sheet (all groups)
• notinsheet [n]  →  only group #n
• leftmembers  →  ACTIVE in sheet but not in any group
• stillin  →  REMOVED in sheet but still in a group

📤 SENDING REMINDERS  (you send them, the bot never does)
  Your daily round — one command per message, run all three:
• dmlist   →  due TODAY  →  1st msg, one tap-to-send link each
• dmlist2  →  ${config.overdue?.autoReminderDays ?? 5} days overdue  →  2nd msg
• dmlist3  →  ${config.overdue?.finalReminderDays ?? 6}+ days overdue  →  3rd msg (final notice)

  Tap a link → the message is already typed → hit send. Attach the QR
  yourself on the ₹${config.renewal.fullAmount} round.

  Or let the bot pace it for you — same links, pushed a few at a time:
• drip        →  what's been pushed today and what's left
• drip test   →  push one batch NOW to check it works (records nothing)
• drip stop   →  pause for today   ·   drip start  →  resume
  It wakes at 9 AM, sends up to 3 links every 18-25 min until 9 PM, and
  re-reads the sheet each time so anyone who pays drops off the rest.

• dmlist [1-31]  →  everyone billed on that day of the month, still unpaid
• dmlist [1-31] msg2|msg3  →  same batch, escalated wording

  The number is a BILLING DATE, not a window: dmlist 27 is everyone whose
  billing date is a 27th, in any month. That is how you dig out of a
  backlog — ~15 people at a time instead of one 115-person dump.

  A date batch defaults to msg1 for everyone, on purpose. Do NOT let it
  auto-escalate: someone 25 days behind would get the final notice as
  their first ever message. Escalate deliberately, days apart:
     Day 1:  dmlist 27         everyone gets the plain ₹${config.renewal.fullAmount} reminder
     Day 3:  dmlist 27 msg2    whoever still hasn't paid
     Day 5:  dmlist 27 msg3    the final notice
  Each run re-reads the sheet, so payers drop off by themselves.

  Nothing goes out on a timer any more. The 6:30/7:30/10:00 jobs stay
  registered but do nothing until reminders move to the official API.

• sent  →  what actually went out today, with Meta's message id per member
  Once reminders run on the official API they leave from a number you can't
  see, so this is the receipt: a message id means Meta accepted it. Failures
  show Meta's own reason — send those few by hand with dmlist.

🧹 GROUP CLEANUP
• kickghosts  →  preview bulk removal of not-in-sheet numbers
• kickghosts confirm  →  start it (15–30 min/person)
• stop kickghosts  →  cancel

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

      const joins    = all.filter(m => isPaidJoinRow(m) && inMonth(m.joinDate, mm, yyyy) && hasForwardBilling(m)).length;
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
    msg += `\n${formatSplit(total, config)}`;
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
      // A member renewed this month is counted as a renewal, not also a join — otherwise a
      // same-month add+renew is billed twice (matches summary/monthly).
      const renewedPhones = new Set(renewed.map(m => m.phone));
      const joins    = all.filter(m => isPaidJoinRow(m) && inMonth(m.joinDate, mm, yyyy) && !renewedPhones.has(m.phone) && hasForwardBilling(m));
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

    const joins    = all.filter(m => isPaidJoinRow(m) && inMonth(m.joinDate, mm, yyyy) && hasForwardBilling(m));
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

    // A member who renews has billingDate pushed ~1 month forward, so once renewed they no longer
    // carry a billingDate in this month. "Due this month" is therefore the UNION of: members
    // renewed this month (their cycle came due and was paid) and members still holding a this-month
    // billing date who haven't renewed (due, unpaid). The two sets are disjoint. The old code
    // derived renewedSet from a billing-anchored "dueThisMonth", which silently dropped every
    // renewed member, so the rate and collected total read ~0%.
    const renewedSet = all.filter(m => m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy));
    const stillDue   = all.filter(m =>
      inMonth(m.billingDate, mm, yyyy) && !(m.lastRenewed && inMonth(m.lastRenewed, mm, yyyy))
    );
    const dueCount = renewedSet.length + stillDue.length;

    const activePending  = stillDue.filter(m => m.status === 'ACTIVE');
    const removedUnpaid  = stillDue.filter(m => m.status === 'REMOVED');
    const skippedUnpaid  = stillDue.filter(m => m.status === 'SKIPPED');

    const rate = dueCount > 0
      ? Math.round((renewedSet.length / dueCount) * 100) : 0;
    const collected    = renewedSet.reduce((s, m) => s + (Number(m.paidLast) || 0), 0);
    const outstanding  = activePending.length * config.renewal.fullAmount;

    let msg = `📊 COLLECTION RATE — ${monthName} ${yyyy}\n\n`;
    msg += `Due this month:    ${dueCount}\n`;
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

    // Members renewed this week take priority over their join: a same-week add+renew counts as a
    // renewal, not a new join (mirrors handleSummary). Without this they'd show as new members.
    const renewedThisWeek = all.filter(m => m.lastRenewed && last7Set.has(toDDMMYYYY(m.lastRenewed)) && Number(m.renewals) > 0);
    const renewedPhones7  = new Set(renewedThisWeek.map(m => m.phone));
    const newThisWeek     = all.filter(m => isPaidJoinRow(m) && last7Set.has(m.joinDate) && !renewedPhones7.has(m.phone) && hasForwardBilling(m));
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

    // Renewed-this-month takes priority over join (mirrors handleSummary): a same-month add+renew
    // counts once, as a renewal — otherwise the member wrongly appears under New Members.
    const allRenewed     = all.filter(m => m.lastRenewed && isIn(m.lastRenewed) && Number(m.renewals) > 0);
    const renewedPhonesM = new Set(allRenewed.map(m => m.phone));
    const newMembers     = all.filter(m => isPaidJoinRow(m) && isIn(m.joinDate) && !renewedPhonesM.has(m.phone) && hasForwardBilling(m));
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
    if (totalRevenue > 0) msg += `\n   Joins ₹${joinRevenue} + Renewals ₹${renewRevenue}\n${formatSplit(totalRevenue, config)}`;
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
