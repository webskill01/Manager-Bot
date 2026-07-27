import {
  daysFromToday, todayStr, friendlyDate, isDelayActive, renewedOn,
  getReferralsInBillingPeriod,
} from './globalConfig.js';

// WhatsApp caps a single message around 4096 chars. Stay well under it: a sendlist line
// is a long url and the operator scrolls this on a phone.
export const MAX_CHARS_PER_MSG = 3000;

// Which wording a member gets when the operator has not forced one. Mirrors the cron's
// own escalation (day-5 nudge, day-6 final) so steady-state behaviour is unchanged.
export function pickStage(overdueDays, config) {
  const final = config.overdue?.finalReminderDays ?? 6;
  const nudge = config.overdue?.autoReminderDays ?? 5;
  if (overdueDays >= final) return 'msg3';
  if (overdueDays >= nudge) return 'msg2';
  return 'msg1';
}

function templateFor(stage, config, { referral }) {
  const m = config.messages || {};
  if (stage === 'msg3') return m.finalReminder || m.overdue || 'Renewal pending — please repay.';
  if (stage === 'msg2') return m.overdue || 'Your renewal date has passed — please repay.';
  return (referral && m.referralReminder) ? m.referralReminder : (m.reminder || 'Your renewal is due today.');
}

// Backwards-only window: billing date today or up to `days` days ago. Messaging someone
// before their month is up reads as wrong and invites a report.
//
// `force` ('msg1'|'msg2'|'msg3') gives everyone the same wording. That exists because
// escalating purely by billing date would hand a 6-day-overdue member the final notice
// as their first ever contact — which is how you collect spam reports. Digging out of a
// backlog is three runs on three days: msg1, then msg2, then msg3.
export function buildSendList({ members, config, days = 0, force = null, now = todayStr() }) {
  const fee = config.joining?.fee ?? 90;
  const all = members;
  const rows = [];

  for (const m of all) {
    if (m.status !== 'ACTIVE') continue;
    const d = daysFromToday(m.billingDate);
    if (d === null || d > 0) continue;              // future billing — never chase early
    const overdueDays = -d;
    if (overdueDays > days) continue;
    if (isDelayActive(m)) continue;
    if (renewedOn(m, now)) continue;

    // 2+ refs are auto-renewed before the list is built, so anyone still here has 0 or 1.
    const refs = getReferralsInBillingPeriod(m.phone, m.billingDate, all);
    const referral = refs.length === 1;
    const stage = force || pickStage(overdueDays, config);
    const text = templateFor(stage, config, { referral })
      .replace('{name}', m.name)
      .replace('{date}', friendlyDate());

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
  return { rows, stageForced: !!force };
}

// Split rendered lines so no single WhatsApp message exceeds `limit`. A line longer than
// the limit still gets its own chunk rather than being dropped.
export function chunkByChars(lines, limit = MAX_CHARS_PER_MSG) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > limit) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += cur.length === 1 ? line.length : add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function renderSendList({ rows, days, stageForced }) {
  if (rows.length === 0) {
    return [`✅ Nobody to remind${days > 0 ? ` in the last ${days} day(s)` : ' today'}.`];
  }
  const stages = [...new Set(rows.map(r => r.stage))].sort();
  const header = `📤 SEND LIST — ${friendlyDate()} · ${rows.length} person(s)` +
    `${days > 0 ? ` · last ${days} day(s)` : ' · due today'}` +
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
