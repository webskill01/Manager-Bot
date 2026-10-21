import { daysFromToday, parseDate, isDelayActive } from '../../core/globalConfig.js';

// Pure. Who to call, in what order, and who is "handled" for now.
//
// Nothing here is stored: the list is rebuilt from the sheets + the panel's own records on
// every request, so a member who pays (bot, panel or app) simply stops matching. A renewal
// moves billingDate forward, which takes them out of every past date range by itself.
//
// Handled people are not dropped, they are `blocked` with a reason: the list view still
// shows them (the admin wants the complete picture), while Focus and the "to call" count
// skip them.

const RETRY_MS = 4 * 3600e3;
const MAX_NO_ANSWER = 3;
const REASON_RANK = { followup: 0, overdue: 1, due: 2, upcoming: 3 };

const has = (want, x) => !want || (Array.isArray(want) ? !want.length || want.includes(x) : want === x);
const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };

// filter: { view: 'today' | 'range', from?, to? (DD-MM-YYYY), bot?, status?, app? (appState), assignee? ('me'|'none'|id), userId? }
// bot / status / app take one value or a list (any of them matches); empty = no filter.
// price: what they pay on the app (₹149); the goal is moving them there, not renewing in groups.
export function buildQueue({ people, botCfg, price = 0, interactions = [], followups = [], assignments = [], claims = [], filter = {}, now = new Date() }) {
  const nowIso = new Date(now).toISOString();
  const dayStart = startOfDay(now).toISOString();
  const byPhone = (list) => list.reduce((m, x) => m.set(x.phone, [...(m.get(x.phone) || []), x]), new Map());
  const todays = byPhone(interactions.filter(i => i.at >= dayStart));
  const lastAny = new Map(interactions.map(i => [i.phone, i]));   // input is time-ordered
  const fuBy = new Map(followups.map(f => [f.phone, f]));          // at most one open per phone
  const assigned = new Map(assignments.map(a => [a.phone, a.user_id]));
  const claimed = new Map(claims.map(c => [c.phone, c.user_id]));
  const from = filter.view === 'range' ? parseDate(filter.from) : null;
  const to = filter.view === 'range' ? parseDate(filter.to) : null;

  const rows = [];
  for (const p of people.values()) {
    if (p.onApp || !p.active.length || !has(filter.app, p.appState)) continue;
    const fu = fuBy.get(p.phone) || null;
    const fuDue = !!fu && fu.due_at <= nowIso;

    // Every ACTIVE membership that matches the filter, most overdue first.
    const hits = p.active
      .filter(({ bot, member }) => botCfg[bot] && !isDelayActive(member) && has(filter.bot, bot))
      .map(({ bot, member }) => ({ bot, member, days: daysFromToday(member.billingDate) }))
      .filter(({ bot, member, days }) => inView({ bot, billingDate: member.billingDate, days, filter, from, to, botCfg, fuDue }))
      .sort((a, b) => a.days - b.days);
    if (!hits.length) continue;

    const { bot, member, days } = hits[0];
    const reason = fuDue ? 'followup' : days < 0 ? 'overdue' : days === 0 ? 'due' : 'upcoming';
    if (!has(filter.status, reason)) continue;

    const assignedTo = assigned.get(p.phone) ?? null;
    if (!assigneeOk(assignedTo, filter)) continue;

    rows.push({
      phone: p.phone,
      name: p.name,
      bot,
      alsoOn: hits.slice(1).map(h => h.bot),
      amount: price,
      appState: p.appState,
      billingDate: member.billingDate,
      days,
      reason,
      followup: fu,
      last: lastAny.get(p.phone) || null,
      assignedTo,
      claimedBy: claimed.get(p.phone) ?? null,
      blocked: blockReason(todays.get(p.phone) || [], fu, fuDue, now),
    });
  }

  return rows.sort((a, b) =>
    (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0)
    || REASON_RANK[a.reason] - REASON_RANK[b.reason]
    || (a.reason === 'followup' ? a.followup.due_at.localeCompare(b.followup.due_at) : 0)
    || a.days - b.days
    || a.name.localeCompare(b.name));
}

function inView({ bot, billingDate, days, filter, from, to, botCfg, fuDue = false }) {
  if (days === null) return false;
  if (filter.view === 'range') {
    const d = parseDate(billingDate);
    return from && to && d >= from && d <= to;
  }
  return (days <= 0 && days >= -botCfg[bot].removalDay) || (fuDue && days <= 0);
}

const assigneeOk = (assignedTo, filter) =>
  !(filter.assignee === 'none' && assignedTo !== null)
  && !(filter.assignee === 'me' && assignedTo !== filter.userId)
  && !(typeof filter.assignee === 'number' && assignedTo !== filter.assignee);

// For the list only: people who would be on it, by the billing date they had when they paid
// on the app (the bot then moves it to the app expiry), but who moved. Shown last, greyed and
// green, so the team sees who actually moved. payments: payment_seen details, time-ordered.
export function movedRows({ people, payments, botCfg, interactions = [], assignments = [], filter = {} }) {
  if (filter.app?.length) return [];   // the app filter picks among the unpaid states
  const from = filter.view === 'range' ? parseDate(filter.from) : null;
  const to = filter.view === 'range' ? parseDate(filter.to) : null;
  const latest = new Map(payments.filter(x => x.source === 'app' && botCfg[x.bot]).map(x => [x.phone, x]));
  const lastAny = new Map(interactions.map(i => [i.phone, i]));
  const assigned = new Map(assignments.map(a => [a.phone, a.user_id]));
  const rows = [];
  for (const pay of latest.values()) {
    const p = people.get(pay.phone);
    const days = daysFromToday(pay.billingFrom);
    if (!p?.onApp || !has(filter.bot, pay.bot) || !inView({ bot: pay.bot, billingDate: pay.billingFrom, days, filter, from, to, botCfg })) continue;
    const reason = days < 0 ? 'overdue' : days === 0 ? 'due' : 'upcoming';
    const assignedTo = assigned.get(p.phone) ?? null;
    if (!has(filter.status, reason) || !assigneeOk(assignedTo, filter)) continue;
    rows.push({
      phone: p.phone, name: p.name, bot: pay.bot, alsoOn: [], amount: pay.amount, appState: p.appState,
      billingDate: pay.billingFrom, days, reason, followup: null, last: lastAny.get(p.phone) || null,
      assignedTo, claimedBy: null, blocked: 'moved', movedAt: pay.at,
    });
  }
  return rows.sort((a, b) => b.movedAt.localeCompare(a.movedAt));
}

function blockReason(today, fu, fuDue, now) {
  if (fu && !fuDue) return 'promised';
  if (fuDue) return null;   // a due follow-up beats anything logged earlier today
  const noAnswers = today.filter(i => i.outcome === 'no_answer');
  if (today.length > noAnswers.length) return 'called_today';
  if (noAnswers.length >= MAX_NO_ANSWER) return 'max_tries';
  const last = noAnswers.at(-1);
  if (last && new Date(now) - new Date(last.at) < RETRY_MS) return 'retry_later';
  return null;
}

// Focus mode order: my assigned work first, then the shared (unassigned) queue. Someone
// else's assignment or live claim is never served to me.
export function focusOrder(rows, userId) {
  const open = rows.filter(r => !r.blocked && (r.claimedBy === null || r.claimedBy === userId));
  return [
    ...open.filter(r => r.assignedTo === userId),
    ...open.filter(r => r.assignedTo === null),
  ];
}
