import { parseDate, formatDate } from '../../core/globalConfig.js';

// Pure numbers for the dashboard and team pages.
// payment = { phone, at (ISO), amount, bot, billingFrom (DD-MM-YYYY the member was due) }
// interaction / followup rows are the db.js shapes.

const WINDOW_MS = 7 * 86400e3;
const CONNECTED = (o) => o !== 'no_answer' && o !== 'wrong_number';

// The last caller to touch the phone in the 7 days before it paid gets the credit.
export function attribute(payments, interactions) {
  return payments.map(p => {
    const t = Date.parse(p.at);
    const hit = interactions
      .filter(i => i.phone === p.phone && Date.parse(i.at) <= t && t - Date.parse(i.at) <= WINDOW_MS)
      .at(-1);
    return { ...p, userId: hit?.user_id ?? null };
  });
}

// Per-day call outcomes and conversions. calls: interactions; moves: attributed app moves.
// day(iso) → bucket key. Every day from..to gets a row (newest first), plus a total.
const OUTS = ['promise', 'callback', 'no_answer', 'not_interested', 'wrong_number'];
const blank = () => ({ calls: 0, people: new Set(), connected: 0, ...Object.fromEntries(OUTS.map(o => [o, 0])), moved: 0, amount: 0 });
const add = (t, i) => {
  t.calls++; t.people.add(i.phone);
  if (CONNECTED(i.outcome)) t.connected++;
  if (t[i.outcome] !== undefined && OUTS.includes(i.outcome)) t[i.outcome]++;
};
const done = (t) => ({ ...t, people: t.people.size });
export function summary({ calls, moves, days, day }) {
  const by = new Map(days.map(d => [d, blank()]));
  const total = blank();
  const callers = new Map();
  const of = (id) => { if (!callers.has(id)) callers.set(id, blank()); return callers.get(id); };
  for (const i of calls) { add(by.get(day(i.at)) || blank(), i); add(total, i); add(of(i.user_id), i); }
  for (const p of moves) {
    for (const t of [by.get(day(p.at)), total, of(p.userId)]) if (t) { t.moved++; t.amount += p.amount; }
  }
  return {
    days: [...by].map(([d, t]) => ({ day: d, ...done(t) })).reverse(),
    total: done(total),
    callers: [...callers].map(([userId, t]) => ({ userId, ...done(t) })),
  };
}

// A promise is kept when the phone paid between making it and one day after its due date.
const kept = (f, payments) => payments.some(p =>
  p.phone === f.phone && p.at >= f.created_at && Date.parse(p.at) <= Date.parse(f.due_at) + 86400e3);

export function team({ users, interactions, followups, payments }) {
  return users.map(u => {
    const mine = interactions.filter(i => i.user_id === u.id);
    const promises = followups.filter(f => f.user_id === u.id && f.kind === 'promise');
    const paid = payments.filter(p => p.userId === u.id);
    return {
      userId: u.id,
      name: u.name,
      calls: mine.length,
      connected: mine.filter(i => CONNECTED(i.outcome)).length,
      promises: promises.length,
      promisesKept: promises.filter(f => kept(f, payments)).length,
      recovered: paid.reduce((s, p) => s + p.amount, 0),
      paidCount: paid.length,
    };
  });
}

export function ageing(rows) {
  const out = { '1-2': 0, '3-5': 0, '6+': 0 };
  for (const { days } of rows) {
    if (days >= 0) continue;
    out[-days <= 2 ? '1-2' : -days <= 5 ? '3-5' : '6+']++;
  }
  return out;
}

// rows = the unpaid queue for the range. Paid people have left it (their billing moved), so
// they are counted back in through the billing date they paid FROM.
export function funnel({ rows, interactions, payments, from, to }) {
  const lo = parseDate(from), hi = parseDate(to);
  const paid = payments.filter(p => { const d = parseDate(p.billingFrom); return d && d >= lo && d <= hi; });
  const due = new Set([...rows.map(r => r.phone), ...paid.map(p => p.phone)]);
  const touched = interactions.filter(i => due.has(i.phone));
  return {
    due: due.size,
    contacted: new Set(touched.map(i => i.phone)).size,
    promised: new Set(touched.filter(i => i.outcome === 'promise').map(i => i.phone)).size,
    paid: new Set(paid.map(p => p.phone)).size,
  };
}

export function recoveredByDay(payments) {
  const days = new Map();
  for (const p of payments) {
    const date = formatDate(new Date(p.at));
    const d = days.get(date) || { date, amount: 0, count: 0 };
    d.amount += p.amount; d.count++;
    days.set(date, d);
  }
  return [...days.values()].sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

export function byBot(rows, payments) {
  const out = {};
  const slot = (bot) => (out[bot] ??= { bot, unpaid: 0, unpaidAmount: 0, paid: 0, paidAmount: 0 });
  for (const r of rows) { slot(r.bot).unpaid++; slot(r.bot).unpaidAmount += r.amount; }
  for (const p of payments) { slot(p.bot).paid++; slot(p.bot).paidAmount += p.amount; }
  return Object.values(out);
}
