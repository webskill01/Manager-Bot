import fs from 'fs';
import path from 'path';

export function loadConfig(botDir) {
  const envPath = path.join(botDir, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }

  const configPath = path.join(botDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  config.ownerNumber = process.env.OWNER_NUMBER || '';
  config.sheetId = process.env.SHEET_ID || '';
  config.botName = process.env.BOT_NAME || config.botName;
  config.statsPort = parseInt(process.env.STATS_PORT || '3010', 10);
  config.serviceAccountPath = path.join(botDir, 'service-account.json');
  config.botDir = botDir;

  // Transport is normally inferred from TELEGRAM_TOKEN alone — no flag to keep in sync
  // with the .env, and no way for the two to disagree. A bot with a token talks to its
  // operator over Telegram and never opens a WhatsApp socket; a bot without one is
  // unchanged Baileys. That is the whole switch for the four tracker bots.
  //
  // "dual" is the one case that cannot be inferred, because it is the same two inputs
  // (token present, auth folder present) as "telegram" and only the operator knows which
  // they meant. bot-nitin declares it in config.json: it keeps the WhatsApp socket for
  // group ops — add/kick/approve, which the Cloud API can never do — while ALSO taking
  // commands over Telegram, so a 403 costs the group commands and nothing else. Both
  // channels drive one process, one sheet cache, one command parser.
  config.telegramToken = process.env.TELEGRAM_TOKEN || '';
  const declaredTransport = (config.transport || '').toLowerCase();
  if (declaredTransport) {
    if (!['whatsapp', 'telegram', 'dual'].includes(declaredTransport)) {
      throw new Error(`Invalid transport "${config.transport}" — must be "whatsapp", "telegram" or "dual"`);
    }
    if (!config.telegramToken && declaredTransport === 'telegram') {
      // A Telegram-only bot without a token can do literally nothing. Refuse to start
      // rather than sit there looking healthy while answering no one.
      throw new Error(
        `transport is "telegram" but TELEGRAM_TOKEN is not set\n` +
        `  → add TELEGRAM_TOKEN=… to ${path.join(botDir, '.env')} (get one from @BotFather),\n` +
        `    or set "transport": "whatsapp" in config.json to run Baileys only.`);
    }
    if (!config.telegramToken && declaredTransport === 'dual') {
      // Dual is different: WhatsApp is the primary channel and Telegram is the backup, so a
      // missing token costs the backup, not the bot. Refusing to boot here would take a live
      // renewal bot down over a not-yet-created Telegram bot — the config can legitimately
      // land in git before the token does. Degrade, and say so every start until it's fixed.
      config.transport = 'whatsapp';
      config.telegramMissing = true;
    } else {
      config.transport = declaredTransport;
    }
  } else {
    config.transport = config.telegramToken ? 'telegram' : 'whatsapp';
  }
  // True whenever a Telegram listener should run, on either of the two transports that
  // have one. Callers branch on this rather than string-matching two values everywhere.
  config.usesTelegram = config.transport === 'telegram' || config.transport === 'dual';

  // The Cloud API token belongs in the gitignored .env, never in config.json — it is a
  // long-lived System User token with permission to message every customer. A token left
  // in config.json goes straight into git history. Reading it here means config.json only
  // ever carries the phoneNumberId and template names, which are not secrets.
  if (process.env.CLOUD_API_TOKEN) {
    config.cloudApi = { ...(config.cloudApi || {}), token: process.env.CLOUD_API_TOKEN };
  }

  // Two of these come from the bot's .env, which is gitignored and therefore never
  // arrives via `git pull` — it must be created by hand on every machine. Naming the
  // variable and the file turns "missing required field: ownerNumber" (which reads like
  // a config.json problem) into something the operator can act on without guessing.
  const required = [
    ['ownerNumber', 'OWNER_NUMBER', '.env'],
    ['sheetId',     'SHEET_ID',     '.env'],
    ['paidGroups',  null,           'config.json'],
  ];
  for (const [field, envVar, source] of required) {
    if (!config[field] || (Array.isArray(config[field]) && config[field].length === 0)) {
      const where = envVar
        ? `set ${envVar} in ${path.join(botDir, '.env')}\n` +
          `  That file is gitignored — "git pull" never delivers it. Copy it from another\n` +
          `  machine, or create it with: BOT_NAME, OWNER_NUMBER, SHEET_ID, STATS_PORT`
        : `add "${field}" to ${path.join(botDir, 'config.json')}`;
      throw new Error(`Config missing required field: ${field} (from ${source})\n  → ${where}`);
    }
  }

  if (config.paidGroups.length === 0) {
    throw new Error('paidGroups must not be empty');
  }

  // Telegram identifies people by a numeric user id, not a phone number, so allowedNumbers
  // cannot authorize anything here — a fresh bot has no way to know who its operators are.
  //
  // An empty list therefore means BOOTSTRAP, not "allow everyone": the bot starts, tells
  // whoever messages it what their own id is, and refuses to run a single command until
  // real ids are configured. That is the whole enrolment flow, with nothing to read out of
  // a log file and no [0] placeholder to remember to remove.
  //
  // Handing a stranger their own Telegram id discloses nothing — they already have it, and
  // it grants no access. The window is minutes, and it shuts by itself the moment the list
  // is filled in.
  if (config.usesTelegram) {
    config.allowedTelegramIds = (config.allowedTelegramIds || []).map(Number).filter(Number.isFinite);
    config.bootstrapMode = config.allowedTelegramIds.length === 0;
    config.dripIds = resolveDripIds(config);
  }

  if (!fs.existsSync(config.serviceAccountPath)) {
    throw new Error(`service-account.json not found at ${config.serviceAccountPath}`);
  }

  // "full"    — the original subscription bot: renewals, referrals, overdue, removals.
  // "tracker" — operators who no longer collect renewals. They gather new joins, call
  //             each person after a month to move them onto the app, then remove them.
  //             No renewal logic, no referrals, no overdue engine, and NO cron jobs at
  //             all: a tracker bot only ever speaks when the operator types a command.
  // Absent → "full", so existing bots are unaffected.
  config.profile = (config.profile || 'full').toLowerCase();
  if (!['full', 'tracker'].includes(config.profile)) {
    throw new Error(`Invalid profile "${config.profile}" — must be "full" or "tracker"`);
  }

  return config;
}

// Who receives the drip. Deliberately NOT allowedTelegramIds: that list is the command
// security boundary and must keep covering every partner, but on a friend bot only the
// friend actually sends the messages — buzzing the other two ~34 times a day is pure noise.
// Absent or empty → everyone allowed, which is the right default for a one-operator bot.
//
// Returned as strings. These are only ever passed to Telegram's chat_id (which takes
// either), never compared against the numeric allowedTelegramIds, so there is no set-
// membership trap here.
export function resolveDripIds(config) {
  const ids = (config?.dripIds || []).map(String).filter(Boolean);
  if (ids.length > 0) return ids;
  return (config?.allowedTelegramIds || []).map(String).filter(Boolean);
}

export function isTracker(config) {
  return config?.profile === 'tracker';
}

// ── Tracker lifecycle ────────────────────────────────────────────────────────
// NEW → CALLED → MOVED. DUE_CALL is never stored: a member is due for their app pitch
// once they've been in the group `callAfterDays` (default 30) and is still NEW. Deriving
// it means there is no daily job to keep a stored flag honest.
// The bot only ever records that a pitch happened and what the person said. It never
// marks anyone as converted and never removes anyone: moving someone onto the app is
// a human act the operator does outside the bot, and they kick the person themselves.
export const TRACKER_STATUSES = ['NEW', 'CALLED'];

// WhatsApp caps one message near 4096 chars. Split rendered lines so no single message
// exceeds `limit`; a line longer than the limit still gets its own chunk rather than
// being dropped.
export const MAX_CHARS_PER_MSG = 3000;

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

// Not yet pitched. NEW is what `add` writes on a tracker bot, but every row that predates
// the tracker profile — migrated members, and anyone added while the bot still ran the full
// renewal profile — carries ACTIVE. Both mean "in the group, never called", so both belong
// in the call queue. Without this, an operator's entire existing member list is invisible to
// `pending` and no sheet migration would be obvious enough to catch it.
export const UNCALLED_STATUSES = ['NEW', 'ACTIVE'];

export function isCallDue(member, callAfterDays = 30, now = new Date()) {
  if (!member || !UNCALLED_STATUSES.includes(member.status)) return false;
  const joined = parseDate(member.joinDate);
  if (!joined) return false;
  const days = Math.round((now.setHours(0, 0, 0, 0) - joined.setHours(0, 0, 0, 0)) / 86400000);
  return days >= callAfterDays;
}

// Called, but nothing came back — no answer, didn't pick up, said "later". That is an
// UNRESOLVED pitch, so it resurfaces after `followUpDays`. Once the operator records
// interested or not-interested the pitch is answered and the person drops out for good.
export function needsFollowUp(member, followUpDays = 3, now = new Date()) {
  if (!member || member.status !== 'CALLED') return false;
  if (member.callResult) return false;   // answered — nothing left to chase
  const called = parseDate(member.callDate);
  if (!called) return true;   // called but undated → always worth chasing
  const days = Math.round((now.setHours(0, 0, 0, 0) - called.setHours(0, 0, 0, 0)) / 86400000);
  return days >= followUpDays;
}

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.slice(-10);
}

export function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Returns "DD-MM-YYYY HH:MM" in local (IST) time — safe replacement for toISOString()
export function formatDateTime(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${mins}`;
}

// Google Sheets, read with UNFORMATTED_VALUE, returns date/time cells as a serial
// number: whole days since 1899-12-30, with a fractional part for the time-of-day.
// The bot writes dates as DD-MM-YYYY text, but a hand-edited cell can be silently
// auto-converted by Sheets into a real date value. Convert any such numeric serial
// back to the bot's canonical string so parsing/display keep working; pass strings
// (and blanks) straight through.
export function normalizeDateCell(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v !== 'number') return v;
  const days = Math.floor(v);
  const frac = v - days;
  const d = new Date(1899, 11, 30);
  d.setDate(d.getDate() + days);
  if (frac > 1e-6) {
    d.setMinutes(d.getMinutes() + Math.round(frac * 24 * 60));
    return formatDateTime(d);
  }
  return formatDate(d);
}

export function parseDate(str) {
  if (!str || !str.includes('-')) return null;
  const parts = str.split('-');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map(Number);
  return new Date(year, month - 1, day);
}

export function daysFromToday(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (1000 * 60 * 60 * 24));
}

export function todayStr() {
  return formatDate(new Date());
}

// True when a once-a-day cron ("m h * * *") would already have fired earlier today, in the
// process-local timezone (the bots run with TZ=Asia/Kolkata, so local time IS IST). Used by
// the reminder/overdue resume() to decide whether a window the bot was offline for should be
// caught up on reconnect. Only the minute+hour fields are read; day/month/weekday are ignored.
// Fail-open: an empty or unparseable expression returns true so a missed reminder is caught up
// rather than silently skipped (the per-phone dedupe still prevents double-sends).
export function cronTimePassedToday(cronExpr, now = new Date()) {
  if (!cronExpr || typeof cronExpr !== 'string') return true;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return true;
  const min = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);
  if (Number.isNaN(min) || Number.isNaN(hour)) return true;
  const threshold = new Date(now);
  threshold.setHours(hour, min, 0, 0);
  return now.getTime() >= threshold.getTime();
}

// Upper bound for restart catch-up. All reminder windows are in the morning (6:30 / 7:30 / 10:00),
// so a reconnect later in the day must NOT replay them — sending "your subscription is due" at
// 11 PM is worse than skipping it until tomorrow. Returns true only while it's still before
// `cutoffHour` (24h local/IST time; defaults to 12 = noon). Catch-up combines this with
// cronTimePassedToday(): replay only if the window already passed AND we're still before noon.
export function beforeCatchUpCutoff(cutoffHour = 12, now = new Date()) {
  return now.getHours() < cutoffHour;
}

// True when a member currently has an active payment "delay" — i.e. delayUntil is set and
// falls on today or in the future. Delayed members stay ACTIVE/overdue but are hidden from
// the bulk removal list until the date passes. Used by `delay [phone] [days]`.
export function isDelayActive(member) {
  if (!member || !member.delayUntil) return false;
  const d = daysFromToday(member.delayUntil);
  return d !== null && d >= 0;
}

// ACTIVE members whose billing date has already passed (i.e. they owe money), sorted
// most-overdue first. `windowDays` bounds how far back to look: null = every overdue
// member (used by `delayall`), a number = only those who fell due within the last N days
// (used by `catchup`, so people who were already overdue BEFORE an outage — and who
// therefore did get their messages — aren't dragged back into the catch-up sequence).
// Members due today (d === 0) are excluded: the normal daily digest still covers them.
export function overdueCohort(members, windowDays = null) {
  return members
    .filter(m => {
      if (!m || m.status !== 'ACTIVE') return false;
      const d = daysFromToday(m.billingDate);
      if (d === null || d >= 0) return false;
      return windowDays === null || Math.abs(d) <= windowDays;
    })
    .sort((a, b) => daysFromToday(a.billingDate) - daysFromToday(b.billingDate));
}

// Builds a Date for `day` of the given month/year, clamped to that month's last day.
// Prevents JS month overflow: day 31 in a 30-day month → the 30th (never spills to next month).
// e.g. clampedBillingDate(2026, 5, 31) → 30 Jun 2026 (not 1 Jul). Month index may be ±, JS normalizes years.
export function clampedBillingDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

// Next billing date for a given billing day-of-month: the soonest date with that day
// that falls STRICTLY after today (clamped for short months). Equivalent to
// "most recent past occurrence of that day + 1 month". Used by `renewed`.
// e.g. today 1 Jun, day 28 → 28 Jun (not 28 Jul). day 1 → 1 Jul (next cycle).
export function nextBillingForDay(day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let candidate = clampedBillingDate(today.getFullYear(), today.getMonth(), day);
  if (candidate <= today) {
    candidate = clampedBillingDate(today.getFullYear(), today.getMonth() + 1, day);
  }
  return candidate;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Human-readable date for messages: "27 May" format
export function friendlyDate(dateStr) {
  const d = dateStr ? parseDate(dateStr) : new Date();
  if (!d) return dateStr || '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// True when `dateStr` ("DD-MM-YYYY") matches the date portion of a stored timestamp,
// handling both storage formats: "DD-MM-YYYY HH:MM" (current) and ISO "YYYY-MM-DD...".
// Shared by the renewal guard and the reminder "already renewed today" filter.
export function dateMatches(stored, dateStr) {
  if (!stored || !dateStr) return false;
  if (stored.length >= 10 && stored[2] === '-') return stored.slice(0, 10) === dateStr;
  const [d, m, y] = dateStr.split('-');
  return stored.startsWith(`${y}-${m}-${d}`);
}

// True when the member was renewed (via the `renewed` command, which sets lastRenewed)
// on the given day. Used to keep reminders away from anyone already renewed that day.
export function renewedOn(member, dateStr) {
  return !!member && dateMatches(member.lastRenewed, dateStr);
}

// True when a member's JOIN_DATE is `dateStr` AND it represents an actual paid join
// (paidLast !== 0). Silent/migrated adds (addsilent) set paidLast = 0 so they are NOT
// counted as new members or join revenue in any report.
export function isPaidJoin(member, dateStr) {
  return !!member && member.joinDate === dateStr && Number(member.paidLast) !== 0;
}

// Referral rollover: from a set of referrals, keep the earliest `keep` (they pay for the
// current free renewal) and return the rest as surplus to roll into the next period.
// Ordered by effective date (refCreditDate || joinDate), earliest first.
export function pickSurplusReferrals(referrals, keep = 2) {
  const sorted = [...referrals].sort((a, b) => {
    const da = parseDate(a.refCreditDate || a.joinDate);
    const db = parseDate(b.refCreditDate || b.joinDate);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });
  return { kept: sorted.slice(0, keep), surplus: sorted.slice(keep) };
}

// A date that falls safely inside the window [newBilling - 1 month, newBilling): the
// midpoint-ish (newBilling - 15 days). Re-pinning a surplus referral's refCreditDate here
// makes getReferralsInBillingPeriod count it in the member's NEXT billing period.
export function surplusCreditDate(newBillingDate) {
  const billing = parseDate(newBillingDate);
  if (!billing) return newBillingDate;
  const d = new Date(billing);
  d.setDate(d.getDate() - 15);
  return formatDate(d);
}

// ─── Revenue split ────────────────────────────────────────────────────────────
// Each bot may define an optional `split` block in config.json describing how the
// month's revenue is divided between the people running it. Example (50-25-25):
//   "split": { "shares": [
//       { "label": "Worker",  "percent": 50 },
//       { "label": "Nitin",   "percent": 25 },
//       { "label": "Partner", "percent": 25 }
//   ] }
// Bots WITHOUT a split block keep the legacy 50-50 two-way behavior ("Per person: ₹X"),
// so bot-nitin is unaffected.

// Returns the configured shares array, or null when none is defined (→ legacy 50-50 path).
export function getSplitShares(config) {
  const shares = config && config.split && config.split.shares;
  if (Array.isArray(shares) && shares.length > 0) return shares;
  return null;
}

// Splits `total` across the configured shares → [{ label, percent, amount }].
// Percentages need not sum to exactly 100 (we normalize). Any rounding drift is
// absorbed by the largest share so the parts always sum back to `total`.
export function computeSplit(total, config) {
  const shares = getSplitShares(config);
  if (!shares) {
    const half = Math.round(total / 2);
    return [
      { label: 'Person 1', percent: 50, amount: half },
      { label: 'Person 2', percent: 50, amount: total - half },
    ];
  }
  const totalPercent = shares.reduce((s, x) => s + (Number(x.percent) || 0), 0) || 100;
  let allocated = 0;
  const parts = shares.map(s => {
    const amount = Math.round((total * (Number(s.percent) || 0)) / totalPercent);
    allocated += amount;
    return { label: s.label || 'Share', percent: Number(s.percent) || 0, amount };
  });
  const drift = total - allocated;
  if (drift !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < parts.length; i++) if (parts[i].amount > parts[maxIdx].amount) maxIdx = i;
    parts[maxIdx].amount += drift;
  }
  return parts;
}

// Renders the split for summaries/reports.
// - No split block  → legacy single line "Per person: ₹X"          (bot-nitin)
// - Split block set → one line per share "Label: ₹X"               (e.g. bot-abhi, 50-25-25)
export function formatSplit(total, config, indent = '   ') {
  if (!getSplitShares(config)) {
    return `${indent}Per person: ₹${Math.round(total / 2)}`;
  }
  return computeSplit(total, config)
    .map(p => `${indent}${p.label}: ₹${p.amount}`)
    .join('\n');
}

// Returns members referred by referrerPhone whose JOIN_DATE (or refCreditDate override) falls within
// [billingDate - 1 month, billingDate) — the referrer's current billing window.
export function getReferralsInBillingPeriod(referrerPhone, billingDate, members) {
  const billing = parseDate(billingDate);
  if (!billing) return [];
  billing.setHours(0, 0, 0, 0);
  const windowStart = new Date(billing);
  windowStart.setMonth(windowStart.getMonth() - 1);
  const normalized = normalizePhone(referrerPhone);
  return members.filter(m => {
    if (!m.reference) return false;
    if (normalizePhone(m.reference) !== normalized) return false;
    const effectiveDate = parseDate(m.refCreditDate || m.joinDate);
    if (!effectiveDate) return false;
    effectiveDate.setHours(0, 0, 0, 0);
    return effectiveDate >= windowStart && effectiveDate < billing;
  });
}
