// The API speaks DD-MM-YYYY (the sheets' format); <input type="date"> speaks YYYY-MM-DD.
const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDmy = (iso) => iso.split('-').reverse().join('-');
export const toIso = (dmy) => dmy.split('-').reverse().join('-');
export const dmy = (d = new Date()) => toDmy(isoDay(d));
export const addDays = (n, d = new Date()) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
export const num = (n) => (n || 0).toLocaleString('en-IN');
export const shortDate = (dmyStr) => dmyStr
  ? new Date(toIso(dmyStr) + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  : '—';
export const when = (iso) => iso
  ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  : '—';
export function ago(iso) {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso)) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
export const daysLabel = (d) => d === 0 ? 'Due today' : d < 0 ? `${-d}d overdue` : `in ${d}d`;
export const botLabel = (b) => b.replace(/^bot-/, '');

export const OUTCOMES = {
  paid: { label: 'Moved to app', tone: 'green' },
  promise: { label: 'Promised', tone: 'blue' },
  callback: { label: 'Call back', tone: 'amber' },
  no_answer: { label: 'No answer', tone: 'gray' },
  not_interested: { label: 'Not interested', tone: 'red' },
  wrong_number: { label: 'Wrong number', tone: 'red' },
};
// Same four states as panel/lib/people.js. Paid = the app's payment count, not its status.
export const APP_STATES = {
  member: { label: 'App member', tone: 'green', hint: 'Paid on the app, plan running. Nothing to do.' },
  lapsed: { label: 'App lapsed', tone: 'amber', hint: 'Paid on the app before, plan ran out. Ask them to renew on the app.' },
  signed_up: { label: 'Signed up on app', tone: 'blue', hint: "Has an app account but never paid. Help them finish." },
  none: { label: 'Not on app', tone: 'gray', hint: 'Not on the app yet.' },
};
export const REASONS = {
  followup: { label: 'Follow-up', tone: 'blue' },
  overdue: { label: 'Overdue', tone: 'red' },
  due: { label: 'Due today', tone: 'amber' },
  upcoming: { label: 'Upcoming', tone: 'gray' },
};
export const BLOCKED = {
  promised: 'Promised',
  called_today: 'Called today',
  max_tries: '3 no-answers',
  retry_later: 'Retry later',
};
