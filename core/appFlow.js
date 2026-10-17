import { daysFromToday, parseDate, todayStr } from './globalConfig.js';

// Two billing flows live side by side for the transition month.
//
// OLD flow: QR payment, day-0 reminder, day-5 nudge, day-6 final, removal list at
// consolidatedListDays overdue. Unchanged.
// APP flow: the EaseCab app is the source of truth. Reminders run BEFORE the date (5 days,
// 2 days, on the day) because the app cuts access on the expiry itself; there is no overdue.
// Removal is the morning after expiry.
//
// A member is on the app flow once they have paid on the app at least once (APP_PAID_UNTIL
// is set) — or, after the bot's `app.cutover` date, everyone is.

export const APP_STATUS_PENDING = 'PENDING_APP';

export function isAppFlow(member, config, today = todayStr()) {
  if (member?.appPaidUntil) return true;
  const cutover = parseDate(config?.app?.cutover || '');
  const now = parseDate(today);
  return !!(cutover && now && now >= cutover);
}

// Which pre-expiry reminder (if any) an app-flow member gets today. Exact days only, so
// each fires once per cycle — the drip rebuilds the list many times a day.
export function appCohort(member) {
  const d = daysFromToday(member?.billingDate);
  if (d === 5) return 'pre5';
  if (d === 2) return 'pre2';
  if (d === 0) return 'due';
  return null;
}

// Whether an ACTIVE member should be removed now.
export function removalDue(member, config, today = todayStr()) {
  if (member?.status !== 'ACTIVE') return false;
  const d = daysFromToday(member.billingDate);
  if (d === null) return false;
  if (isAppFlow(member, config, today)) return d < 0;
  const stopAt = config?.overdue?.consolidatedListDays ?? ((config?.overdue?.finalReminderDays ?? 6) + 1);
  return -d >= stopAt;
}
