import { isTracker } from './globalConfig.js';

// `help` used to be one ~90-line message. On a phone that is a wall you scroll past looking
// for the one command you half-remember, which is the opposite of help. It is now an index
// of sections plus `help <section>`, and telegramTransport renders the same sections as
// buttons underneath — so nobody has to know the section names to use them.
//
// The categories live here, in one list, because two places own them: this file builds the
// text and telegramTransport builds the buttons. A category in one but not the other is
// either a dead button or an unreachable section, so a test pins them together.
//
// [key, label, hint] — the hint is the one-line "what is in here" the index shows.
export const HELP_CATEGORIES = {
  full: [
    ['members',   '👤 Members',   'add, kick, rejoin, skip, links'],
    ['renewals',  '💰 Renewals',  'renewed, advance, remind, due, overdue'],
    ['referrals', '👥 Referrals', 'ref, refs'],
    ['lookup',    '🔍 Lookup',    'find, status'],
    ['reports',   '📊 Reports',   'digest, summary, weekly, monthly'],
    ['reminders', '📤 Reminders', 'dmlist, dmlist2, dmlist3, drip'],
    ['cleanup',   '🧹 Cleanup',   'kickghosts'],
    ['bulk',      '⚡ Bulk',      'R1 S2 W3, removal, warnall, kickall'],
    ['analytics', '📈 Analytics', 'growth, trend, forecast, churn, audit'],
  ],
  tracker: [
    ['flow',     '🔄 The flow',  'how a member moves through this bot'],
    ['members',  '👤 Add',       'add, sendlinks, rejoin'],
    ['calling',  '📞 Calling',   'pending, called, log'],
    ['lookup',   '🔍 Lookup',    'find, status, removed, skipped'],
    ['reports',  '📊 Reports',   'digest, summary, revenue, weekly'],
    ['audits',   '🔍 Audits',    'notinsheet, leftmembers, stillin'],
    ['cleanup',  '🧹 Cleanup',   'kick, kickghosts'],
  ],
};

export const categoriesFor = (config) => HELP_CATEGORIES[isTracker(config) ? 'tracker' : 'full'];

function fullBodies(config) {
  const nudge = config.overdue?.autoReminderDays ?? 5;
  const final = config.overdue?.finalReminderDays ?? 6;
  // Auto-send bots and manual-drip bots disagree about the single most important sentence
  // in this file — who actually presses send. One config read rather than two help files.
  const auto = config.drip?.mode === 'auto';
  const dripStart = config.drip?.startHour ?? (auto ? 6 : 9);
  const dripEnd = config.drip?.endHour ?? (auto ? 18 : 21);
  // Derived, never written down: the ceiling is one over the floor, and a help text that
  // says "3 an hour" while the config says 15 minutes is worse than no help text.
  const perHour = Math.round(60 / ((config.drip?.gapMinMs ?? (auto ? 1200000 : 1080000)) / 60000));
  const nudgeDay = config.overdue?.autoReminderDays ?? 5;
  const fee = config.renewal.fullAmount;

  return {
    members: `👤 MEMBERS
• add [Name] [phone] / [day] / ref [refPhone]
• add [Name] [phone] ref [refPhone] prev  →  credit ref to referrer's PREVIOUS billing period
• addsilent [Name] [phone]  →  sheet only, no links, NOT counted as new member
• rejoin [phone] / [phone] [day]
• kick [phone]
• skip [phone] [reason]  /  unskip [phone]
• delay [phone] [days]  →  hide from removal list N days (still overdue; default 1)
• delayall [days]  →  preview delaying EVERYONE overdue (billing dates unchanged)
• delayall [days] confirm  →  apply it
• approve / approveall  /  rejectall
• sendlinks [phone]  /  links [phone]
• links  →  cached invite links (what the bot actually sends)
• refreshlinks  →  re-fetch all invite links (~2 min — paced, run it once)
• setlink [n] [url]  →  replace one link by hand, no redeploy
• groupcheck [phone]`,

    renewals: `💰 RENEWALS
• renewed [phone]  →  ₹${fee}
• renewed [phone] force  →  override same-month block
• renewed [phone] 45  →  ₹${config.renewal.referralAmount}
• renewed [phone] [day]  /  [day] 45
• advance [phone] [months]  →  billing +N months, ₹${fee}×N banked today
• remind [phone]  →  send reminder + QR manually
• dm [phone] …  →  tap-to-send links, any member, any day
• checknum [phone] …  →  does WhatsApp actually know this number?
• checksend [phone]  →  send a test and report if it ARRIVED
• due / due tomorrow
• upcoming [days]  →  who's due in next N days (default 7)
• overdue / pending`,

    referrals: `👥 REFERRALS
• [phone] ref [refPhone]
• [phone] ref [refPhone] prev  →  credit ref to referrer's PREVIOUS billing period
• refs [phone]`,

    lookup: `🔍 LOOKUP
• find [phone or name]  →  full profile + ref count
• status [phone]`,

    reports: `📊 REPORTS  (pull-only — nothing is sent to you on a schedule)
• digest  →  today's due / overdue / auto-renewed (was the 6 AM cron)
• summary / summary 1 / summary 2  →  (was the 10 PM cron)
• weekly  →  last 7 days
• monthly / monthly [month] / monthly [month] [year]
• stats / revenue / groups / ping
• removed  /  skipped
• notinsheet  →  in group but missing from sheet (all groups)
• notinsheet [n]  →  only group #n
• leftmembers  →  ACTIVE in sheet but not in any group
• stillin  →  REMOVED in sheet but still in a group
• ledger  →  the shared revenue sheet (it fills itself at 10 PM and 5 AM)`,

    reminders: `📤 SENDING REMINDERS  ${auto ? '(the bot sends them itself)' : '(you send them, the bot never does)'}
  The ladder — every member gets at most three, then they are done:
• dmlist   →  due TODAY  →  1st msg, one tap-to-send link each
• dmlist2  →  ${nudge} days overdue  →  2nd msg
• dmlist3  →  ${final} days overdue  →  3rd msg (final notice, the LAST one)

  Day ${(config.overdue?.consolidatedListDays ?? final + 1)} they stop getting messages and move to the removal
  list — see \`overdue\` and \`kickall\`. Nobody is chased forever.

  ${auto
    ? 'The three commands above still work by hand — use them to chase\n  someone off-schedule, or if you stop the drip for the day.'
    : `Tap a link → the message is already typed → hit send. Attach the QR\n  yourself on the ₹${fee} round.`}
${auto ? `
  This bot does not wait for your thumb:
• drip        →  how many it has sent today and what is left
• drip plan   →  the WHOLE day up front — who, in what order, roughly when
• drip test   →  preview the next one in Telegram (sends nothing, records nothing)
• drip stop   →  stop sending for today   ·   drip start  →  resume
  It wakes at ${dripStart} AM and sends ONE reminder at a time until ${dripEnd > 12 ? dripEnd - 12 : dripEnd} PM, never
  more than ${perHour} an hour, and stretches the gap out on a quiet day so ten
  reminders spread across the whole window instead of finishing by 9.
  It re-reads the sheet before every send, so anyone who pays drops off.
  The first message of the day lands at a random time, never on the hour.
  Order is due-today first, then the ${nudgeDay}-day nudge, then the final notice —
  renewals before follow-ups, so a full day drops chase-ups and not money.
  The QR rides the due-today message only, once per member per month.
  The QR goes with the FIRST message each member gets in a billing cycle,
  whichever one that is — so somebody missed on their due date still gets
  it with their day-${nudge} message. It is not re-sent later in the same cycle.

  Before each send it checks the member is still IN one of your groups.
  Anyone who left is skipped and listed at day end — \`kick\` them so they
  stop coming round. If the group list can't be read, it sends anyway.

  If more people are queued than the day has room for, it says so at ${dripStart} AM.
  The overflow rolls to tomorrow; clear it by hand with dmlist if you'd
  rather it went out today — then hit "✅ Sent these" (or send
  \`dmlist done\`) so the bot skips them and nobody gets it twice.
  Five failed sends in a row stop the day.
` : `
  Or let the bot pace it for you — same links, pushed a few at a time:
• drip        →  what's been pushed today and what's left
• drip plan   →  the WHOLE day up front — who, in what order, roughly when
• drip test   →  push one batch NOW to check it works (records nothing)
• drip stop   →  pause for today   ·   drip start  →  resume
  It wakes at ${dripStart} AM, sends up to 3 links every 18-25 min until ${dripEnd > 12 ? dripEnd - 12 : dripEnd} PM, and
  re-reads the sheet each time so anyone who pays drops off the rest.
`}
• dmlist [1-31]  →  everyone billed on that day of the month, still unpaid
• dmlist [1-31] msg2|msg3  →  same batch, escalated wording
• dmlist done  →  "I sent that batch myself" — today only

  Printing a list changes nothing on its own, so you can run dmlist just
  to look. \`dmlist done\` is what marks the last one as handled by you.

  The number is a BILLING DATE, not a window: dmlist 27 is everyone whose
  billing date is a 27th, in any month. That is how you dig out of a
  backlog — ~15 people at a time instead of one 115-person dump.

  A date batch defaults to msg1 for everyone, on purpose. Do NOT let it
  auto-escalate: someone 25 days behind would get the final notice as
  their first ever message. Escalate deliberately, days apart:
     Day 1:  dmlist 27         everyone gets the plain ₹${fee} reminder
     Day 3:  dmlist 27 msg2    whoever still hasn't paid
     Day 5:  dmlist 27 msg3    the final notice
  Each run re-reads the sheet, so payers drop off by themselves.

  The 6:30/7:30/10:00 jobs stay registered but do nothing until reminders
  move to the official API.${auto ? ' The drip above is what sends.' : ' Nothing goes out on a timer.'}

• sent  →  what actually went out today, with Meta's message id per member
  Once reminders run on the official API they leave from a number you can't
  see, so this is the receipt: a message id means Meta accepted it. Failures
  show Meta's own reason — send those few by hand with dmlist.`,

    cleanup: `🧹 GROUP CLEANUP
• kickghosts  →  preview bulk removal of not-in-sheet numbers
• kickghosts confirm  →  start it (15–30 min/person)
• stop kickghosts  →  cancel`,

    analytics: `📈 BUSINESS ANALYTICS
• growth    →  6-month member growth trend
• trend     →  6-month revenue history
• forecast  →  projected revenue this month
• churn     →  this month's net member change
• collection →  monthly collection rate %
• toprefs   →  all-time referral leaderboard
• loyal     →  top members by renewals
• norenew   →  never-renewed (churn risk) list
• tenure    →  avg member lifetime
• audit     →  data quality check`,

    bulk: `⚡ OVERDUE ACTIONS
Send "overdue" first, then reply:
• R[n] — Remove  /  S[n] — Skip  /  W[n] — Warn
Example: R1 R2 S3

🚫 BULK REMOVAL (7+ days overdue)
• removal  /  warnall  /  kickall  /  stop kickall

🔁 TRIAL GROUP
• start removal  /  stop removal`,
  };
}

function trackerBodies(config) {
  const days = config.tracker?.callAfterDays ?? 30;
  const chase = config.tracker?.followUpDays ?? 3;
  const noWhatsApp = config.transport === 'telegram';

  return {
    flow: `🔄 THE FLOW
  add → (${days} days pass) → pending → call them → log what they said
  NEW  →  CALLED (interested / not interested / no answer)

This bot only keeps the record. It never moves anyone onto the app and
never removes anyone — you do that yourself with "kick [phone]".

⏱️ A person appears in "pending" ${days} days after joining. Called with no
answer logged reappears after ${chase} day(s).
This bot has NO scheduled jobs — it only acts when you send a command.`,

    members: noWhatsApp
      ? `👤 ADD A NEW PERSON
This bot has no WhatsApp connection, so the group work is yours. It writes
the sheet and hands you a one-tap link to send from your own WhatsApp.
• add [Name] [phone]  →  records as NEW + tap-to-send links & welcome
• addsilent [Name] [phone]  →  sheet only, no link prepared
• sendlinks [phone]  →  the tap-to-send link again
• links [phone]  →  just the group invite links, to paste anywhere
• rejoin [phone]  →  reactivate an old member in the sheet

Approving join requests, group membership checks and bulk group removals
are done in WhatsApp by hand — the bot will say so if you try them here.`
      : `👤 ADD A NEW PERSON
• add [Name] [phone]  →  sends group links + welcome, records as NEW
• addsilent [Name] [phone]  →  sheet only, no links sent
• sendlinks [phone]  →  re-send the links
• approve / approveall  →  approve pending join requests
• rejectall
• rejoin [phone]  →  add an old member back
• groupcheck [phone]  →  which groups are they in?`,

    calling: `📞 CALLING
• pending  →  who to call now (${days}d in group) + who gave no answer yet
• called [phone] interested      →  logs the call + date + "interested"
• called [phone] not interested  →  logs the call + date + "not interested"
• called [phone]                 →  logs the call + date, no answer yet
     reappears in "pending" after ${chase} day(s) until you log an answer
     any of these can be re-run later to correct what you logged
• called [phone] interested [Name]  →  for someone NOT in the sheet:
     creates their row and logs the call in one go
• log  →  the full record: interested / not interested / no answer /
          not called yet.  ("calls" does the same thing)

Nobody is ever removed by these. When you want a seat back: kick [phone]
Once kicked, they vanish from "pending" and "log" for good.`,

    lookup: `🔍 LOOKUPS
• find [phone or name]  /  status [phone]
• removed  /  skipped`,

    reports: `📊 REPORTS  (nothing is ever sent to you on a timer)
• digest  →  today at a glance
• summary / summary 1  →  the day's money: joins, revenue, split
     (call activity is NOT here — that's "log")
• revenue  →  joining fees this month + split
• weekly / monthly / growth / trend
• stats / groups / ping
• ledger  →  the shared revenue sheet (it fills itself at 10 PM and 5 AM)`,

    audits: `🔍 GROUP AUDITS
• notinsheet  →  in a group but missing from the sheet
• leftmembers  →  in the sheet but not in any group
• stillin  →  REMOVED in the sheet but still in a group`,

    cleanup: `🧹 CLEANUP
• kick [phone]  →  remove from all groups
• kickghosts / kickghosts confirm / stop kickghosts`,
  };
}

export const bodiesFor = (config) => (isTracker(config) ? trackerBodies(config) : fullBodies(config));

function index(config) {
  // A dash, not padded columns. Telegram renders message text in a PROPORTIONAL font, so
  // padEnd never lines anything up there — and it cannot even count right: `⚡` is one UTF-16
  // unit where `👤` is a surrogate pair, so identical-looking labels pad to different widths.
  const rows = categoriesFor(config).map(([, label, hint]) => `${label} — ${hint}`).join('\n');
  return `📋 BOT COMMANDS

Tap a section below, or type it:  help reports

${rows}

help all  →  every command in one message`;
}

// `help`, `help <section>`, `help all`. Sections match on prefix, so `help rem` finds
// reminders and a half-remembered name still lands somewhere useful.
export function renderHelp(config, arg = '') {
  const bodies = bodiesFor(config);
  const cats = categoriesFor(config);
  const q = String(arg || '').trim().toLowerCase();

  if (!q) return index(config);
  if (q === 'all') {
    const title = isTracker(config) ? '📋 BOT COMMANDS — tracker' : '📋 BOT COMMANDS';
    return [title, ...cats.map(([key]) => bodies[key])].join('\n\n');
  }

  const hit = cats.find(([key]) => key === q) || cats.find(([key]) => key.startsWith(q));
  if (hit) return bodies[hit[0]];
  return `❓ No help section called "${arg}".\n\n${index(config)}`;
}
