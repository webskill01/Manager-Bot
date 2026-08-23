import { google } from 'googleapis';
import { dailyBreakdown } from './handlers/reportHandlers.js';
import { formatDate, parseDate, todayStr, normalizeDateCell, yesterdayStr, columnIndex } from './globalConfig.js';

// The shared daily ledger: every bot writes its own day's counts into ONE spreadsheet the
// operator keeps their revenue formulas in.
//
// Counts only — never rupees. Joining fees, renewal amounts and the revenue split all live
// in the operator's sheet formulas already, and duplicating them here would give two answers
// to "what did we earn on the 3rd" the first time a price changed. The bots know how many
// people; the sheet knows what a person is worth.
//
// ── Why four bots can share one tab with no locking ──────────────────────────
// The tab is keyed on (DATE, BOT), and a bot only ever touches rows carrying its OWN name,
// so two bots can never target the same row — there is nothing to race for. New rows go
// through values.append with INSERT_ROWS, which allocates at the end server-side and so
// cannot overwrite a row another bot added a millisecond earlier. And because appends only
// ever land after the last row, a row index read a moment ago is still valid when the update
// goes out. No lock, no leader, no coordination.

const TAB = 'LOG';
const HEADER = ['DATE', 'BOT', 'NEW', 'RENEWED'];

// Every date from `from` to `to` inclusive, as DD-MM-YYYY. Returns [] when the range is
// backwards or either end is unparseable, so a typo'd startDate writes nothing rather than
// looping forever.
export function datesBetween(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end || start > end) return [];
  const out = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) out.push(formatDate(d));
  return out;
}

// What the ledger should say for each date, given the member sheet as it stands right now.
// Pure — no I/O — so the diffing below is testable without touching Google.
export function ledgerRowsFor(members, config, dates) {
  return dates.map(date => {
    const { newToday, weightedRenewals } = dailyBreakdown(members, config, date);
    return { date, bot: config.botName, newJoined: newToday.length, renewed: weightedRenewals };
  });
}

// Which of `wanted` actually need writing, given what the tab already holds. Rows whose
// numbers already match are skipped: a morning reconcile over a year of history would
// otherwise rewrite 365 rows every day to change nothing.
export function diffRows(wanted, existing) {
  const have = new Map(existing.map(r => [`${r.date}|${r.bot}`, r]));
  const appends = [];
  const updates = [];
  for (const row of wanted) {
    const prev = have.get(`${row.date}|${row.bot}`);
    if (!prev) { appends.push(row); continue; }
    if (prev.newJoined !== row.newJoined || prev.renewed !== row.renewed) {
      updates.push({ ...row, rowIndex: prev.rowIndex });
    }
  }
  return { appends, updates };
}

export function createLedger(config, store, log) {
  const settings = config.ledger || {};
  const enabled = !!settings.spreadsheetId;
  const tab = settings.tab || TAB;
  let sheets = null;

  // A config.json that asks for a ledger but has no id to write to means the .env is missing
  // LEDGER_SHEET_ID — the one part of this that `git pull` cannot deliver, because .env is
  // gitignored. Left quiet, the 10 PM and 6 AM jobs would run, no-op and report nothing, and
  // the first sign of trouble would be an empty sheet a week later. Say it at boot instead.
  if (config.ledger && !enabled) {
    log?.warn?.('📒 Ledger configured but DISABLED — LEDGER_SHEET_ID is missing from ' +
                `${config.botDir || 'this bot'}/.env. Nothing will be written.`);
  }

  async function client() {
    if (sheets) return sheets;
    const auth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccountPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return sheets;
  }

  async function read() {
    const api = await client();
    const res = await api.spreadsheets.values.get({
      spreadsheetId: settings.spreadsheetId,
      range: `${tab}!A2:D`,
      // The bot writes dates as DD-MM-YYYY text, but a hand edit can turn a cell into a real
      // date, which UNFORMATTED_VALUE returns as a serial number. FORMATTED_VALUE gives back
      // what the sheet displays, which is what the DD-MM-YYYY key matching needs.
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return (res.data.values || []).map((row, i) => ({
      rowIndex: i + 2,
      date: String(row[0] || '').trim(),
      bot: String(row[1] || '').trim(),
      newJoined: Number(row[2] || 0),
      renewed: Number(row[3] || 0),
    })).filter(r => r.date && r.bot);
  }

  // Tab + header, created on first run so the operator does not have to build the tab by
  // hand and get the column order wrong. Silent when the tab already exists.
  async function ensureTab() {
    const api = await client();
    const meta = await api.spreadsheets.get({ spreadsheetId: settings.spreadsheetId });
    if (meta.data.sheets?.some(sh => sh.properties?.title === tab)) return;
    await api.spreadsheets.batchUpdate({
      spreadsheetId: settings.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: settings.spreadsheetId,
      range: `${tab}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
    log.info(`📒 Ledger tab "${tab}" created`);
  }

  const toCells = r => [r.date, r.bot, r.newJoined, r.renewed];

  // Sync the given dates. Refreshes the member sheet first (someone added since the last
  // refresh must count), computes every date, and writes only what actually differs.
  async function sync(dates) {
    if (!enabled) {
      log?.warn?.('📒 Ledger skipped — no LEDGER_SHEET_ID in this bot’s .env');
      return { skipped: 'no LEDGER_SHEET_ID configured', dates: 0, appended: 0, updated: 0 };
    }
    if (dates.length === 0) return { appended: 0, updated: 0, dates: 0 };

    await store.refresh();
    await ensureTab();

    const wanted = ledgerRowsFor(store.getAll(), config, dates);
    const { appends, updates } = diffRows(wanted, await read());
    const api = await client();

    if (appends.length > 0) {
      await api.spreadsheets.values.append({
        spreadsheetId: settings.spreadsheetId,
        range: `${tab}!A:D`,
        valueInputOption: 'RAW',
        // INSERT_ROWS, never the OVERWRITE default: two bots appending at the same moment
        // must each get their own row. See the header comment.
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: appends.map(toCells) },
      });
    }
    if (updates.length > 0) {
      // One request for the whole set — Sheets allows 60 writes a minute per user, and all
      // four bots share a single service account.
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: settings.spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates.map(r => ({ range: `${tab}!A${r.rowIndex}:D${r.rowIndex}`, values: [toCells(r)] })),
        },
      });
    }

    log.info(`📒 Ledger sync — ${dates.length} date(s): ${appends.length} added, ${updates.length} corrected`);
    return { appended: appends.length, updated: updates.length, dates: dates.length };
  }

  // 10 PM: today's numbers as they stand. Deliberately not the last word — anything logged
  // between now and midnight is picked up by the morning reconcile.
  const writeToday = () => sync([todayStr()]);

  // 6 AM: correct yesterday and fill any gap back to startDate in one pass. This is what
  // lets a bot that was down overnight — or for a week — heal itself with no intervention,
  // and it is why the 10 PM write is allowed to be provisional.
  //
  // ponytail: recomputes the whole history every morning. Free at a year of dates over ~1000
  // members, and only DIFFERING rows are written. Cap the window if it ever gets slow.
  const reconcile = () => sync(datesBetween(settings.startDate || yesterdayStr(), yesterdayStr()));

  // Read one figure back OUT of the operator's own summary tab — the day's total per person,
  // as their formulas computed it. Deliberately a read: the bots write counts and never
  // rupees, so this reports their arithmetic rather than re-deriving it and disagreeing.
  //
  // Returns null when unconfigured or when that date has no row yet, which is the normal
  // state on every bot except the one whose operator owns the sheet.
  async function totalFor(dateStr) {
    const tab = settings.summaryTab;
    const col = columnIndex(settings.totalColumn);
    if (!enabled || !tab || col < 0) return null;
    const api = await client();
    const res = await api.spreadsheets.values.get({
      spreadsheetId: settings.spreadsheetId,
      range: `${tab}!A2:Z`,
      // UNFORMATTED: a real date cell comes back as a serial that normalizeDateCell turns
      // into DD-MM-YYYY, so a column displaying "1 July" still matches. A column of plain
      // TEXT dates would not — it would need to be typed as dates, or written DD-MM-YYYY.
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const row = (res.data.values || []).find(r => normalizeDateCell(r[0]).slice(0, 10) === dateStr);
    const value = row?.[col];
    return Number.isFinite(Number(value)) && value !== '' ? Number(value) : null;
  }

  async function status() {
    if (!enabled) return '📒 Ledger is off — no "ledger.spreadsheetId" in this bot\'s config.json.';
    const mine = (await read()).filter(r => r.bot === config.botName);
    const last = mine[mine.length - 1];
    return `📒 Ledger — ${mine.length} day(s) recorded for ${config.botName}\n` +
      `Tab: ${tab}  ·  since ${settings.startDate || '(yesterday)'}\n` +
      (last ? `Last row: ${last.date} — ${last.newJoined} new, ${last.renewed} renewed` : 'No rows yet.');
  }

  return { enabled, sync, writeToday, reconcile, status, totalFor };
}
