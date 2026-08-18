import {
  daysFromToday, todayStr, friendlyDate, isDelayActive, renewedOn, parseDate,
  getReferralsInBillingPeriod, chunkByChars, MAX_CHARS_PER_MSG, pickVariant,
} from './globalConfig.js';

// Re-exported for tests and for callers that already import them from here.
export { chunkByChars, MAX_CHARS_PER_MSG };

// Which wording a member gets when the operator has not forced one. Mirrors the cron's
// own escalation (day-5 nudge, day-6 final) so steady-state behaviour is unchanged.
export function pickStage(overdueDays, config) {
  const final = config.overdue?.finalReminderDays ?? 6;
  const nudge = config.overdue?.autoReminderDays ?? 5;
  if (overdueDays >= final) return 'msg3';
  if (overdueDays >= nudge) return 'msg2';
  return 'msg1';
}

// Each message may be a string or an array of variants — see pickVariant. The pick is keyed
// on the member's phone so it is stable for them within the day, which matters because the
// drip re-renders this list before every push.
function templateFor(stage, config, { referral, phone }) {
  const m = config.messages || {};
  const pick = (v) => pickVariant(v, phone);
  if (stage === 'msg3') return pick(m.finalReminder) || pick(m.overdue) || 'Renewal pending — please repay.';
  if (stage === 'msg2') return pick(m.overdue) || 'Your renewal date has passed — please repay.';
  return (referral && m.referralReminder) ? pick(m.referralReminder) : (pick(m.reminder) || 'Your renewal is due today.');
}

// Two ways to pick who lands on the list. Both are backwards-only — messaging someone
// before their month is up reads as wrong and invites a report.
//
// `cohort` slices by how overdue someone is, one command per wording:
//   'due'    exactly 0d over  → msg1   (dmlist)
//   'nudge'  exactly Nd over  → msg2   (dmlist2, N = config.overdue.autoReminderDays)
//   'final'  Nd or more over  → msg3   (dmlist3, N = config.overdue.finalReminderDays)
// The stage falls out of pickStage on its own — a cohort's overdue days already map to the
// wording it wants, so there is no cohort→stage table to keep in sync.
//
// `billingDay` (1–31) instead slices by day of the month, across every month: the way to
// work a backlog down in ~15-person batches rather than one 115-person dump.
//
// `force` ('msg1'|'msg2'|'msg3') overrides the wording for everyone. Date batches always
// pass one, because escalating a 25-day-overdue member purely by age would hand them the
// final notice as their first ever contact — which is how you collect spam reports.
export function buildDmList({ members, config, cohort = 'due', billingDay = null, force = null, now = todayStr() }) {
  const fee = config.joining?.fee ?? 90;
  const nudge = config.overdue?.autoReminderDays ?? 5;
  const final = config.overdue?.finalReminderDays ?? 6;
  const all = members;
  const rows = [];

  for (const m of all) {
    if (m.status !== 'ACTIVE') continue;
    const d = daysFromToday(m.billingDate);
    if (d === null || d > 0) continue;              // future billing — never chase early
    const overdueDays = -d;

    if (billingDay !== null) {
      // The d > 0 guard above already dropped this month's not-yet-due 27th, so what's
      // left is every past 27th the member still owes for.
      if (parseDate(m.billingDate)?.getDate() !== billingDay) continue;
    } else if (cohort === 'nudge') {
      if (overdueDays !== nudge) continue;
    } else if (cohort === 'final') {
      if (overdueDays < final) continue;
    } else {
      if (overdueDays !== 0) continue;
    }

    if (isDelayActive(m)) continue;
    if (renewedOn(m, now)) continue;

    // 2+ refs are auto-renewed before the list is built, so anyone still here has 0 or 1.
    const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
    const referral = refs.length === 1;
    const stage = force || pickStage(overdueDays, config);
    // {date} is the member's OWN billing date, not today. On a backlog run today's date is
    // simply wrong — telling someone billed on the 20th that their date is the 28th reads
    // as a mistake and invites an argument about what they actually owe.
    const text = templateFor(stage, config, { referral, phone: m.phone })
      .replace('{name}', m.name)
      .replace('{date}', friendlyDate(m.billingDate));

    rows.push({
      name: m.name,
      phone: m.phone,
      overdueDays,
      stage,
      fee: referral ? Math.round(fee / 2) : fee,
      text,
      link: `https://wa.me/91${m.phone}?text=${encodeURIComponent(text)}`,
    });
  }

  rows.sort((a, b) => b.overdueDays - a.overdueDays);
  return { rows, stageForced: !!force, cohort, billingDay };
}

// Which slice this list is, in the two places the operator reads: the header suffix and
// the "nobody" line. Keeps the day counts coming from config rather than hardcoded 5/6.
function describe({ cohort, billingDay, config }) {
  if (billingDay !== null && billingDay !== undefined) {
    const suffix = billingDay === 1 ? 'st' : billingDay === 2 ? 'nd' : billingDay === 3 ? 'rd' : 'th';
    return {
      label: `billed on the ${billingDay}${suffix}`,
      empty: `✅ Nobody billed on the ${billingDay}${suffix} is due right now.`,
    };
  }
  if (cohort === 'nudge') {
    const n = config?.overdue?.autoReminderDays ?? 5;
    return { label: `${n} days overdue`, empty: `✅ Nobody is ${n} days overdue.` };
  }
  if (cohort === 'final') {
    const n = config?.overdue?.finalReminderDays ?? 6;
    return { label: `${n}+ days overdue`, empty: `✅ Nobody is ${n}+ days overdue.` };
  }
  return { label: 'due today', empty: '✅ Nobody is due today.' };
}

export function renderDmList({ rows, stageForced, cohort = 'due', billingDay = null, config = null }) {
  const { label, empty } = describe({ cohort, billingDay, config });
  if (rows.length === 0) return [empty];

  const stages = [...new Set(rows.map(r => r.stage))].sort();
  const header = `📤 DM LIST — ${friendlyDate()} · ${rows.length} person(s) · ${label}` +
    `\n${stageForced ? `Forced: ${stages[0]}` : `Auto: ${stages.join(' + ')}`}` +
    `\nTap a link → message is pre-typed → hit send.\n━━━━━━━━━━━━━━━━━━━`;

  const lines = rows.map((r, i) => {
    const age = r.overdueDays === 0 ? 'due today' : `${r.overdueDays}d overdue`;
    return `${String(i + 1).padStart(3)}. ${r.name} · ₹${r.fee} · ${age}\n${r.link}`;
  });

  return chunkByChars(lines).map((chunk, i, arr) =>
    (i === 0 ? `${header}\n\n` : `📤 (${i + 1}/${arr.length})\n\n`) + chunk.join('\n\n')
  );
}
