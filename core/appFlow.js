import fs from 'fs';
import path from 'path';
import { daysFromToday, parseDate, todayStr } from './globalConfig.js';

// Two billing flows live side by side for the transition month.
//
// OLD flow: QR payment, day-0 reminder, day-5 nudge, day-6 final, removal list at
// consolidatedListDays overdue. Unchanged.
// APP flow: the EaseCab app is the source of truth. Reminded on the expiry day and the day
// after; removed (from the paid groups and config.appGroupId) the day after that.
//
// A member is on the app flow once they have paid on the app at least once (APP_PAID_UNTIL
// is set) — or, after the bot's `app.cutover` date, everyone is.

export const APP_STATUS_PENDING = 'PENDING_APP';

// Member right now = an active plan running on the app. Paid on the app, or given by hand
// (paid the operator directly, paidCount 0): both are members, same reminders, same groups
// (operator, 17-11-2026). Pre-launch beta plans still running count too.
export function liveOnApp(row, nowIso = new Date().toISOString()) {
  return !!row && row.status === 'active' && !!row.expiresAt && row.expiresAt > nowIso;
}

export function isAppFlow(member, config, today = todayStr()) {
  if (member?.appPaidUntil) return true;
  const cutover = parseDate(config?.app?.cutover || '');
  const now = parseDate(today);
  return !!(cutover && now && now >= cutover);
}

// Which reminder (if any) an app-flow member gets today: the expiry day, and the day after.
// Exact days only, so each fires once per cycle — the drip rebuilds the list many times a
// day. (pre5/pre2 were dropped 14-11-2026: the app itself warns before expiry.)
export function appCohort(member, asOf = null) {
  const d = daysFromToday(member?.billingDate, asOf);
  if (d === 0) return 'due';
  if (d === -1) return 'after';
  return null;
}

const stopAtOf = (config) =>
  config?.overdue?.consolidatedListDays ?? ((config?.overdue?.finalReminderDays ?? 6) + 1);

// The drip's contact log (qr-sent.json): { phone: { cycle, qr, at, start } }.
export function loadContactLog(botDir) {
  try { return JSON.parse(fs.readFileSync(path.join(botDir, 'qr-sent.json'), 'utf8')); }
  catch { return {}; }
}

// Fresh start (config.freshStart = { from, perDay }). Group-track members already at or past
// the removal day on `from` are the backlog: their ladder restarts on the day the drip first
// reaches them (contact log `start` = their new day 0, then day 5/6, removal day 7). Until
// reached they are only in the capped 'fresh' cohort and never on the removal list.
export function isBacklog(member, config) {
  const from = config?.freshStart?.from;
  if (!from || isAppFlow(member, config)) return false;
  const d = daysFromToday(member?.billingDate, from);
  return d !== null && -d >= stopAtOf(config);
}

// The date a member's ladder counts from: their billing date, or for a backlog member the
// day they were restarted — null while they have not been reached yet.
export function ladderDate(member, config, contactLog = {}) {
  if (!isBacklog(member, config)) return member.billingDate;
  const c = contactLog[String(member.phone)];
  return c?.cycle === member.billingDate && c.start ? c.start : null;
}

// Whether an ACTIVE member should be removed now.
export function removalDue(member, config, today = todayStr(), contactLog = {}) {
  if (member?.status !== 'ACTIVE') return false;
  const lad = ladderDate(member, config, contactLog);
  const d = lad === null ? null : daysFromToday(lad);
  if (d === null) return false;
  // App: reminded on the day and the day after, removed the day after that.
  if (isAppFlow(member, config, today)) return d <= -2;
  return -d >= stopAtOf(config);
}
