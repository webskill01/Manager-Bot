import { normalizePhone, formatDate, todayStr, daysFromToday, formatDateTime, getReferralsInBillingPeriod, nextBillingForDay, isDelayActive, clampedBillingDate, parseDate } from '../globalConfig.js';
import { markPhoneReminded } from '../reminderSender.js';

export function createRenewalHandlers(store, config, log) {

  async function handleRenewed(args) {
    if (args.length < 1) return `❌ Format: renewed [phone]  or  renewed [phone] ${config.renewal.referralAmount}  or  renewed [phone] [date 1-31]  or  renewed [phone] [date] ${config.renewal.referralAmount}`;
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: renewed 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    // Parse remaining args: the referral price → referral tier, 1–31 → billing day,
    // 'force' → override the same-month block.
    //
    // The referral token was hardcoded '45', which is bot-nitin's price and nobody else's. On
    // a bot priced 100/50, `renewed X 50` matched neither branch — 50 is not '45' and is out
    // of the 1–31 day range — so it silently recorded the FULL amount and the operator's
    // sheet was ₹50 heavy with no error to notice. Read the price from config instead.
    //
    // Day wins over price when the two collide (a bot priced ₹25 with a member billed on the
    // 25th): a day is what the two-arg form is for, and the price is already the default.
    const referralToken = String(config.renewal.referralAmount);
    let amount = config.renewal.fullAmount;
    let billingDay = null;
    const isForce = args.slice(1).some(a => a.toLowerCase() === 'force');
    for (const arg of args.slice(1)) {
      if (/^\d{1,2}$/.test(arg) && parseInt(arg) >= 1 && parseInt(arg) <= 31) {
        billingDay = parseInt(arg);
      } else if (arg === referralToken) {
        amount = config.renewal.referralAmount;
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

  // `advance [phone] [months]` — someone pays several months up front.
  //
  // Deliberately NOT `renewed ... force` repeated N times. That path resets the billing day
  // to today whenever the member is overdue, so paying 6 months ahead on the 3rd would move
  // a 27th-of-the-month member to the 3rd forever. Here the anniversary day never moves: N
  // months are added to the date they already have, in ONE step.
  //
  // One step matters for short months. 31 Jan + 1 + 1 clamps to 28 Feb and then to 28 Mar,
  // losing three days permanently; 31 Jan + 2 in one go is 31 Mar, which is what the member
  // paid for.
  //
  // Money: paidLast is the WHOLE amount handed over (fee × months), which is what the
  // operator actually banked today. dailyBreakdown divides it back out by the monthly fee, so
  // one 6-month advance reports as ₹540 and as 6 renewals on the day it was taken, and as
  // nothing at all for the five months it covers. That is the honest shape — the cash arrived
  // once — and it keeps the local `summary` and the shared ledger telling the same story.
  async function handleAdvance(args) {
    if (args.length < 2) {
      return '❌ Format: advance [phone] [months]\nExample: advance 9855112233 3  → billing +3 months, ' +
             `₹${config.renewal.fullAmount * 3} recorded today`;
    }
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: advance 98551XXXXX 3';

    // Digits only, checked BEFORE parseInt: parseInt('2.5') is 2 and parseInt('3 months') is
    // 3, so a typo would be silently rounded into a real payment rather than questioned.
    // Capped at 24 because the only thing a three-digit typo can do here is push a paying
    // member's billing date out of reach and silence their reminders for a decade — and
    // nobody ever notices a member who quietly stops being asked for money.
    const months = /^\d+$/.test(String(args[1]).trim()) ? parseInt(args[1], 10) : NaN;
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      return '❌ Months must be a whole number 1–24.\nExample: advance 9855112233 3';
    }

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    const from = parseDate(member.billingDate);
    if (!from) return `❌ ${member.name} has no readable billing date (${member.billingDate || 'blank'}). Fix that first with: renewed ${phone} [1-31]`;

    const newBillingDate = formatDate(
      clampedBillingDate(from.getFullYear(), from.getMonth() + months, from.getDate())
    );
    const amount = config.renewal.fullAmount * months;
    const wasOverdue = (daysFromToday(member.billingDate) ?? 0) < 0;
    // Read off before the write. store.update() refreshes from the sheet, so `member` is a
    // pre-update snapshot today — but that is a property of the store, not of this handler,
    // and a "20-11-2026 → 20-11-2026" receipt is a confusing thing to hand someone who just
    // paid ₹270.
    const wasBilling = member.billingDate;
    const nowRenewals = (member.renewals || 0) + months;

    await store.update(phone, {
      status: 'ACTIVE',
      billingDate: newBillingDate,
      renewals: nowRenewals,
      paidLast: amount,
      lastRenewed: formatDateTime(new Date()),
      delayUntil: '',
    });

    // Same belt-and-suspenders as `renewed`: a member who just paid must not be caught by
    // today's reminder batch or by the drip an hour later.
    if (config.botDir) markPhoneReminded(config.botDir, phone);

    return `✅ ${member.name} — ${months} month${months !== 1 ? 's' : ''} paid in advance @ ₹${amount}\n` +
      `📦 Billing ${wasBilling} → ${newBillingDate}\n` +
      (wasOverdue
        ? `ℹ️ They were overdue, so the first of those ${months} clears the arrears.\n`
        : '') +
      `🔄 Total renewals: ${nowRenewals}`;
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

  return { handleRenewed, handleAdvance, handleDue, handleOverdue, handlePending };
}
