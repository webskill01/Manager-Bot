import fs from 'fs';
import { buildDmList } from '../dmList.js';
import { renderHelp } from '../helpText.js';
import path from 'path';
import { daysFromToday, todayStr, getReferralsInBillingPeriod, parseDate, formatDate, normalizePhone, formatSplit, isPaidJoin, isTracker, isCallDue, needsFollowUp, yesterdayStr, datesInMonth } from '../globalConfig.js';

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

// Splits paid renewals into MUTUALLY EXCLUSIVE full/referral buckets. Some bots price both tiers
// the same (abhi/aayush2: full == referral), and a plain two-filter split then put every renewal
// in BOTH lists — duplicate names and double-counted revenue. When the amounts are equal there is
// no referral tier to report, so everything paid lands in `full`.
// Revenue is summed from what was actually paid, so an off-tier amount is never silently dropped.
export function splitRenewals(paidRenewals, config) {
  const { fullAmount, referralAmount } = config.renewal;
  const hasReferralTier = referralAmount !== fullAmount;
  return {
    full: paidRenewals.filter(m => !hasReferralTier || Number(m.paidLast) !== referralAmount),
    referral: hasReferralTier ? paidRenewals.filter(m => Number(m.paidLast) === referralAmount) : [],
    revenue: paidRenewals.reduce((s, m) => s + (Number(m.paidLast) || 0), 0),
  };
}

// Checks lastUpdated against a given date string ("DD-MM-YYYY") — handles both storage formats
function isUpdatedOn(lastUpdated, dateStr) {
  if (!lastUpdated) return false;
  if (lastUpdated.startsWith(dateStr)) return true;
  // Old ISO format: convert DD-MM-YYYY → YYYY-MM-DD for comparison
  const [d, m, y] = dateStr.split('-');
  return lastUpdated.startsWith(`${y}-${m}-${d}`);
}

// One day's money, as DATA rather than as a rendered report.
//
// `summary` used to compute this inline and bake it straight into a string, which was fine
// while the string was the only consumer. The nightly ledger is a second consumer, and two
// places computing "how many joined today" is exactly the drift that once made `digest` and
// its own cron disagree about who was due. So both read this.
//
// `weightedRenewals` counts a full-price renewal as 1 and a half-price referral renewal as
// 0.5 — the number the operator's revenue sheet expects. Ref-free auto-renewals (₹0, earned
// with 2 referrals) are listed but NOT counted: they bring in nothing.
export function dailyBreakdown(all, config, dateStr) {
  // A member explicitly renewed on this date is a RENEWAL, never a new join — even when they
  // were also added that day (an existing member re-added via `add`, then `renewed`).
  //
  // Keyed on lastRenewed, which ONLY the `renewed` command and auto-renew set. lastUpdated is
  // bumped by every write (kickall's status→REMOVED included), so keying on that would make a
  // previously-renewed member who was removed today wrongly appear as renewed today.
  const renewedOnDate = m => m.lastRenewed && isUpdatedOn(m.lastRenewed, dateStr) && m.renewals > 0;

  if (isTracker(config)) {
    // No renewal machinery on a tracker bot — these operators collect a joining fee and
    // nothing else. Matches the tracker branch of `summary` exactly, hasForwardBilling
    // included: a hand-edited joinDate must not read as a new join here either.
    const joined = all.filter(m => isPaidJoin(m, dateStr) && hasForwardBilling(m));
    return {
      newToday: joined, renewedToday: [], autoRenewedToday: [],
      fullRenewals: [], referralRenewals: [], weightedRenewals: 0,
      joinRevenue: joined.length * config.joining.fee, renewalRevenue: 0,
      totalRevenue: joined.length * config.joining.fee,
    };
  }

  const newToday = all.filter(m => isPaidJoin(m, dateStr) && !renewedOnDate(m) && hasForwardBilling(m));
  const byRenewedAt = (a, b) => (a.lastRenewed || '').localeCompare(b.lastRenewed || '');
  const renewedToday = all.filter(m => renewedOnDate(m) && Number(m.paidLast) !== 0).sort(byRenewedAt);
  const autoRenewedToday = all.filter(m => renewedOnDate(m) && Number(m.paidLast) === 0).sort(byRenewedAt);

  const { full, referral, revenue: renewalRevenue } = splitRenewals(renewedToday, config);
  const joinRevenue = newToday.length * config.joining.fee;

  // Renewals in MONTHS, not in people. Was `full.length + referral.length * 0.5`, which is
  // the same answer for both ordinary tiers (₹90 → 1, ₹45 → 0.5) and the wrong one the moment
  // `advance` exists: a 6-month advance is one person and ₹540, and a ledger counting it as
  // one renewal told the operator's sheet to bill it as ₹90. Dividing the cash actually taken
  // by the monthly fee covers every tier and every future one with no table to keep in sync.
  const fee = config.renewal.fullAmount || 1;
  const weightedRenewals =
    Math.round(renewedToday.reduce((s, m) => s + (Number(m.paidLast) || 0), 0) / fee * 100) / 100;

  return {
    newToday, renewedToday, autoRenewedToday,
    fullRenewals: full, referralRenewals: referral,
    weightedRenewals,
    joinRevenue, renewalRevenue, totalRevenue: joinRevenue + renewalRevenue,
  };
}

export function createReportHandlers(store, config, botStartTime, log, ledger = null) {

  // The cross-bot block appended to every revenue report on the bot whose config names a
  // summaryTab — in practice bot-nitin, the one whose operator owns the revenue sheet. The
  // friend bots name no summaryTab, so this returns '' and each of them keeps reporting its
  // own money and nothing else, which is exactly what their operators should see.
  //
  // Figures come from the operator's sheet, never recomputed here: there is one answer to
  // what a day earned and it is the one their formulas give. Returns '' rather than throwing
  // on any failure — a Sheets hiccup must never cost someone their whole revenue report.
  async function allBotsBlock(label, dates) {
    try {
      const res = await ledger?.sumFor(dates);
      if (!res) return '';
      const { sums, missing = [] } = res;
      const width = Math.max(...Object.keys(sums).map(k => k.length)) + 1;
      const lines = Object.entries(sums)
        .map(([k, v]) => `   ${`${k}:`.padEnd(width)} ₹${v}`)
        .join('\n');
      // The shared sheet fills at 9 PM and again at 5 AM, so a window containing today — or
      // yesterday, before the morning pass — sums FEWER days than its heading names. Silent,
      // that is simply a wrong number: a 26-08 → 01-09 weekly reported ₹4755 over six days
      // while 01-09 sat unwritten. Name the days that are not in the figure instead.
      const note = missing.length === 0 ? ''
        : `\n   ⏳ Not counted yet: ${missing.length > 3 ? `${missing.length} of ${dates.length} days` : missing.join(', ')}`
        + `\n      (the shared sheet fills at 9 PM and 5 AM)`;
      return `\n\n🌐 ALL BOTS — ${label}\n${lines}${note}`;
    } catch (err) {
      log?.warn?.(`⚠️  Cross-bot totals unavailable: ${err.message}`);
      return '';
    }
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

    // Who actually gets chased TODAY — not "everyone 5+ days overdue", which is what this
    // used to say and was wrong in the way that matters: it swept in the 20- and 40-day
    // backlog too, so a line promising warnings were going out named ~100 people the bot
    // will never message. Past consolidatedListDays a member leaves the message ladder
    // entirely and lands on the removal list instead (`removal` / `kickall`).
    //
    // Same source as the sends themselves — buildDmList, one cohort each — so this line and
    // the drip cannot drift apart. `overdue` above stays the raw running count.
    const warnDays = config.overdue?.autoReminderDays ?? 5;
    const finalDay = config.overdue?.finalReminderDays ?? 6;
    const nudgeRows = buildDmList({ members: all, config, cohort: 'nudge' }).rows;
    const finalRows = buildDmList({ members: all, config, cohort: 'final' }).rows;
    const warnToday = [...nudgeRows, ...finalRows];
    const stopAt = config.overdue?.consolidatedListDays ?? (finalDay + 1);
    const forRemoval = overdue.filter(m => Math.abs(daysFromToday(m.billingDate) || 0) >= stopAt);
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
      msg += `\n🚨 GETTING CHASED TODAY: ${warnToday.length} member${warnToday.length !== 1 ? 's' : ''}\n`;
      if (nudgeRows.length > 0) {
        msg += `   msg2 · ${warnDays}d overdue (${nudgeRows.length}):\n`;
        msg += nudgeRows.map(r => `      • ${r.name}  ${r.phone}`).join('\n') + '\n';
      }
      if (finalRows.length > 0) {
        msg += `   msg3 · final notice, ${finalDay}d overdue (${finalRows.length}):\n`;
        msg += finalRows.map(r => `      • ${r.name}  ${r.phone}`).join('\n') + '\n';
      }
    }

    // Named apart because it is a different action, not a louder warning: these people are
    // done being messaged and are waiting on a yes/no from the operator.
    if (forRemoval.length > 0) {
      msg += `\n🛑 PAST THE LADDER — no more messages (${forRemoval.length}) — run \`removal\`.\n`;
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

    // Yesterday's take, read straight off the operator's own revenue sheet. Not having to
    // open that sheet is the entire point of the ledger, and the morning digest is the first
    // thing they read anyway. Reported, never re-derived — the bots write counts and the
    // sheet owns the money maths, so there is only ever one answer.
    //
    // Silent on every bot but the one whose config names a summaryTab, and silent on the
    // first morning of a new sheet. try/catch like every block around it: a Sheets hiccup
    // must never cost the operator the whole digest.
    const y = yesterdayStr();
    msg += await allBotsBlock(`yesterday, ${y}`, [y]);

    // Catch-up progress is deliberately NOT here. `catchup` prints its own status on
    // demand, and the digest is a money view — a line about a group broadcast the operator
    // started themselves is noise every morning of a cycle.

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
      msg += await allBotsBlock(targetDateStr, [targetDateStr]);

      return msg;
    }

    // Every count and every rupee below comes from dailyBreakdown, which the nightly ledger
    // also reads. Two implementations of "how many joined today" is how `digest` and its own
    // cron once ended up disagreeing about who was due.
    const {
      newToday, renewedToday, autoRenewedToday, fullRenewals, referralRenewals,
      weightedRenewals, joinRevenue, renewalRevenue, totalRevenue,
    } = dailyBreakdown(all, config, targetDateStr);

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
    msg += await allBotsBlock(targetDateStr, [targetDateStr]);

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

  async function handleRevenue() {
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
        `✅ Interested in the app, all time: ${interested}` +
        await allBotsBlock(`${monthLabel} ${yyyy}`, datesInMonth(now.getMonth() + 1, now.getFullYear()));
    }

    // Renewals: only count entries where the "renewed" command was actually run this month.
    // Uses lastRenewed (set exclusively by handleRenewed) so kicks/skips/other ops don't pollute the count.
    const renewedThisMonth = all.filter(m => m.lastRenewed && isUpdatedThisMonth(m.lastRenewed));
    const { full: fullRenewals, referral: referralRenewals, revenue: renewalRevenue } =
      splitRenewals(renewedThisMonth.filter(m => Number(m.paidLast) !== 0), config);

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
    msg += await allBotsBlock(`${monthName} ${yyyy}`, datesInMonth(now.getMonth() + 1, now.getFullYear()));

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
  // The help text lives in core/helpText.js: ~200 lines of prose that has nothing to do
  // with computing a report, and telegramTransport needs the same category list to build
  // the buttons under it.
  function handleHelp(args = []) {
    return renderHelp(config, args[0]);
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
  async function handleWeekly() {
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
    msg += await allBotsBlock(`${last7[0]} → ${last7[6]}`, last7);
    return msg;
  }

  // ─── MONTHLY SUMMARY ─────────────────────────────────────────────────────────
  async function handleMonthly(args = []) {
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
    const { full: fullRenewals, referral: halfRenewals, revenue: renewRevenue } = splitRenewals(paidRenewed, config);
    const removedMembers = all.filter(m => m.status === 'REMOVED' && isIn(m.lastUpdated));
    const skippedMembers = all.filter(m => m.status === 'SKIPPED' && isIn(m.lastUpdated));

    const joinRevenue    = newMembers.length * config.joining.fee;
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
    msg += await allBotsBlock(monthLabel, datesInMonth(targetMonth, targetYear));

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
