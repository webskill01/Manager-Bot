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
