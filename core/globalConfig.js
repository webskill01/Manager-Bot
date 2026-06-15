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

  const required = ['ownerNumber', 'sheetId', 'paidGroups'];
  for (const field of required) {
    if (!config[field] || (Array.isArray(config[field]) && config[field].length === 0)) {
      throw new Error(`Config missing required field: ${field}`);
    }
  }

  if (config.paidGroups.length === 0) {
    throw new Error('paidGroups must not be empty');
  }

  if (!fs.existsSync(config.serviceAccountPath)) {
    throw new Error(`service-account.json not found at ${config.serviceAccountPath}`);
  }

  return config;
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

// True when a member currently has an active payment "delay" — i.e. delayUntil is set and
// falls on today or in the future. Delayed members stay ACTIVE/overdue but are hidden from
// the bulk removal list until the date passes. Used by `delay [phone] [days]`.
export function isDelayActive(member) {
  if (!member || !member.delayUntil) return false;
  const d = daysFromToday(member.delayUntil);
  return d !== null && d >= 0;
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
// so bot-nitin and bot-2 are unaffected.

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
// - No split block  → legacy single line "Per person: ₹X"          (bot-nitin, bot-2)
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
