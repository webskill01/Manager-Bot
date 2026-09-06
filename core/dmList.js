import {
  daysFromToday, todayStr, friendlyDate, isDelayActive, renewedOn, parseDate,
  getReferralsInBillingPeriod, chunkByChars, MAX_CHARS_PER_MSG, pickVariant,
} from './globalConfig.js';

// Re-exported for tests and for callers that already import them from here.
export { chunkByChars, MAX_CHARS_PER_MSG };

// What a member on a RENEWAL list actually owes. Was `config.joining.fee`, halved for a
// referral — right only on bot-nitin, where the joining fee, the renewal price and half of it
// happen to equal 90/90/45. On the flat-priced bots (99 or 100 with no referral tier) a 1-ref
// member's row read ₹50 next to a message asking them for ₹99. The renewal price is the
// renewal config, not the joining one.
function renewalFee(config, referral) {
  const r = config.renewal || {};
  const full = Number(r.fullAmount) || config.joining?.fee || 90;
  if (!referral) return full;
  const ref = Number(r.referralAmount);
  return Number.isFinite(ref) && ref > 0 ? ref : Math.round(full / 2);
}

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
// keyed on the row's position in the list, so the wordings rotate 1-2-3-1-2-3 instead of
// two neighbours drawing the same one. Stable across re-renders because the row order is
// — the drip rebuilds this list before every push and must not swap the text under it.
function templateFor(stage, config, { referral, phone, seq }) {
  const m = config.messages || {};
  const pick = (v) => pickVariant(v, phone, undefined, seq);
  if (stage === 'msg3') return pick(m.finalReminder) || pick(m.overdue) || 'Renewal pending — please repay.';
  if (stage === 'msg2') return pick(m.overdue) || 'Your renewal date has passed — please repay.';
  return (referral && m.referralReminder) ? pick(m.referralReminder) : (pick(m.reminder) || 'Your renewal is due today.');
}

// One member's reminder, outside any cohort.
//
// buildDmList slices by who is due; this answers "that specific person, right now" — which is
// what you need when the bot reported a send it did not make, and the member has since fallen
// off every cohort. A day-6 member missed yesterday is day 7 today: past the ladder, absent
// from dmlist3, and otherwise unreachable without retyping the message by hand.
//
// Same templates, same {name}/{date} substitution and the same global replace as the list, so
// a hand-sent reminder is word-for-word the one the drip would have sent.
export function dmRowFor(member, config, { stage = null, referral = false } = {}) {
  const d = daysFromToday(member.billingDate);
  const overdueDays = d === null ? 0 : Math.max(0, -d);
  const chosen = stage || pickStage(overdueDays, config);
  const text = templateFor(chosen, config, { referral, phone: member.phone })
    .replace(/\{name\}/g, member.name)
    .replace(/\{date\}/g, friendlyDate(member.billingDate));
  return {
    name: member.name,
    phone: member.phone,
    billingDate: member.billingDate,
    overdueDays,
    stage: chosen,
    fee: renewalFee(config, referral),
    text,
    link: `https://wa.me/91${member.phone}?text=${encodeURIComponent(text)}`,
  };
}

// Two ways to pick who lands on the list. Both are backwards-only — messaging someone
// before their month is up reads as wrong and invites a report.
//
// `cohort` slices by how overdue someone is, one command per wording:
//   'due'    exactly 0d over        → msg1   (dmlist)
//   'nudge'  exactly Nd over        → msg2   (dmlist2, N = config.overdue.autoReminderDays)
//   'final'  Nd over, up to Rd      → msg3   (dmlist3, N = finalReminderDays, R = consolidatedListDays)
// The stage falls out of pickStage on its own — a cohort's overdue days already map to the
// wording it wants, so there is no cohort→stage table to keep in sync.
//
// The 'final' cohort is BOUNDED at the top, and that bound is the point of the ladder. It
// used to read `overdueDays >= final`, so a member 6 days overdue got the final notice, then
// got it again on day 7, day 8 and every day after — the drip re-sent it because they never
// stopped matching. Chasing someone daily forever is what earns a spam report, and it also
// made the final notice a lie: it is only final if something happens next. At
// consolidatedListDays (7) they leave the message ladder entirely and appear on the removal
// list, which `overdue` prints and `kickall` acts on. No more messages — a decision instead.
//
// `billingDay` (1–31) instead slices by day of the month, across every month: the way to
// work a backlog down in ~15-person batches rather than one 115-person dump.
//
// `force` ('msg1'|'msg2'|'msg3') overrides the wording for everyone. Date batches always
// pass one, because escalating a 25-day-overdue member purely by age would hand them the
// final notice as their first ever contact — which is how you collect spam reports.
export function buildDmList({
  members, config, cohort = 'due', billingDay = null, force = null,
  contactLog = {}, now = todayStr(),
}) {
  const nudge = config.overdue?.autoReminderDays ?? 5;
  const final = config.overdue?.finalReminderDays ?? 6;
  // One past the last day anyone is messaged on. Defaults to final + 1 rather than a bare 7
  // so a bot that moves finalReminderDays does not silently grow a gap of silent days, or a
  // window where the final notice repeats.
  const stopAt = config.overdue?.consolidatedListDays ?? (final + 1);
  const all = members;
  const rows = [];
  let seq = 0;   // rotation counter, advanced only for members who actually make the list

  for (const m of all) {
    if (m.status !== 'ACTIVE') continue;
    const d = daysFromToday(m.billingDate);
    if (d === null || d > 0) continue;              // future billing — never chase early
    const overdueDays = -d;

    if (billingDay !== null) {
      // The d > 0 guard above already dropped this month's not-yet-due 27th, so what's
      // left is every past 27th the member still owes for.
      if (parseDate(m.billingDate)?.getDate() !== billingDay) continue;
    } else if (cohort === 'missed') {
      // The four-day hole. 'due' is exactly day 0 and 'nudge' is exactly day 5, so a member
      // whose due-day message never went out — the window overflowed, the socket was down,
      // the account was restricted and the link was handed over and never tapped — was on no
      // list and in no queue until day 5. On 24-08-2026 a whole day's batch fell in here and
      // nothing found them again.
      //
      // "Never heard from us this cycle" is the whole test, and contactLog is the record:
      // billingDate is the cycle id, so a member who WAS reached is excluded by their own
      // entry and drops out the moment they renew. With no log passed, every member in the
      // window qualifies — correct for a caller that has no way to know better.
      if (overdueDays < 1 || overdueDays >= nudge) continue;
      if (contactLog[String(m.phone)]?.cycle === m.billingDate) continue;
    } else if (cohort === 'nudge') {
      if (overdueDays !== nudge) continue;
    } else if (cohort === 'final') {
      if (overdueDays < final || overdueDays >= stopAt) continue;
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
    const text = templateFor(stage, config, { referral, phone: m.phone, seq: seq++ })
      // Global, not first-occurrence. A plain-string .replace() swaps only the first match,
      // so a template mentioning the member twice would send the second one as the literal
      // text "{name}". Cheap to get wrong now that operators write several variants each.
      .replace(/\{name\}/g, m.name)
      .replace(/\{date\}/g, friendlyDate(m.billingDate));

    rows.push({
      name: m.name,
      phone: m.phone,
      // Carried so the auto-sender can tell one billing cycle from the next: it attaches the
      // QR to the first message of each cycle, and "which cycle" is exactly this string.
      billingDate: m.billingDate,
      overdueDays,
      stage,
      fee: renewalFee(config, referral),
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
  if (cohort === 'missed') {
    const n = config?.overdue?.autoReminderDays ?? 5;
    return {
      label: `1-${n - 1} days overdue, never messaged this cycle`,
      empty: '✅ Nobody was missed — everyone past their date has heard from us.',
    };
  }
  if (cohort === 'nudge') {
    const n = config?.overdue?.autoReminderDays ?? 5;
    return { label: `${n} days overdue`, empty: `✅ Nobody is ${n} days overdue.` };
  }
  if (cohort === 'final') {
    const n = config?.overdue?.finalReminderDays ?? 6;
    const stop = config?.overdue?.consolidatedListDays ?? (n + 1);
    // "6 days overdue", not "6+": past `stop` they are on the removal list, not this one, and
    // a header promising 6+ while the rows stop at 6 is how the day-7 bug stayed invisible.
    const label = stop - n <= 1 ? `${n} days overdue` : `${n}-${stop - 1} days overdue`;
    return { label, empty: `✅ Nobody is ${label} — final notice.` };
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
