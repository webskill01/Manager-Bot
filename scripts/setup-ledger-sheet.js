// Builds the SUMMARY tab in the shared ledger spreadsheet: one row per day, every figure a
// formula over the LOG tab the bots write.
//
//   node scripts/setup-ledger-sheet.js [--through DD-MM-YYYY] [--force]
//
// Run once. It refuses to touch a SUMMARY tab that already has rows unless --force, because
// the operator's own edits live there and a re-run must never silently flatten them.
//
// Why the bots do not write these columns themselves: they write COUNTS, and the sheet owns
// what a count is worth. Fees change; a formula in one place changes with them, and a fee
// duplicated into four bot configs does not.

import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { datesBetween } from '../core/ledger.js';
import { formatDate, loadConfig } from '../core/globalConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Through loadConfig, not a raw config.json read: the spreadsheet id lives in bot-nitin's
// .env, so the sheet this writes can never drift from the one the bots write.
const cfg = loadConfig(path.join(ROOT, 'bots/bot-nitin'));
const { spreadsheetId, tab: logTab = 'LOG', startDate } = cfg.ledger;
const SUMMARY = cfg.ledger.summaryTab || 'SUMMARY';

const HEADER = [
  'DATE', 'NEW JOINED', 'RENEWED', 'ABHINAV', 'SACHIN', 'AAYUSH', 'BOT 2',
  'REVENUE BY US', 'PER PERSON BY US', 'REVENUE BY THEM', 'BOT 2 REVENUE', 'TOTAL PER PERSON',
];

// ₹90 a head on bot-nitin (joins and renewals price the same), and a flat ₹25 per head from
// each friend bot — that is what they actually remit, regardless of what they charge.
const OUR_RATE = cfg.joining.fee;      // 90
const THEIR_CUT = 25;
const OUR_SHARE = 2;                   // revenue by us splits two ways

// The tab name is ALWAYS quoted. "LOG" is also a Sheets function (LOG(value, base)), so a
// bare LOG!$C:$C parses as a call and every formula returns #N/A "Argument must be a range".
// Quoting is free and covers spaces and every other reserved name too.
const T = `'${logTab}'`;

// A friend bot's column is joins + renewals in one figure.
const both = (bot, row) =>
  `SUMIFS(${T}!$C:$C,${T}!$A:$A,$A${row},${T}!$B:$B,"${bot}")` +
  `+SUMIFS(${T}!$D:$D,${T}!$A:$A,$A${row},${T}!$B:$B,"${bot}")`;

const one = (col, bot, row) =>
  `SUMIFS(${T}!$${col}:$${col},${T}!$A:$A,$A${row},${T}!$B:$B,"${bot}")`;

function formulaRow(row) {
  return [
    `=${one('C', 'bot-nitin', row)}`,          // B  NEW JOINED
    `=${one('D', 'bot-nitin', row)}`,          // C  RENEWED (weighted: a half-price one is 0.5)
    `=${both('bot-abhi', row)}`,               // D  ABHINAV
    `=${both('bot-sachin2', row)}`,            // E  SACHIN
    `=${both('bot-aayush2', row)}`,            // F  AAYUSH
    0,                                          // G  BOT 2 — no such bot yet
    `=(B${row}+C${row})*${OUR_RATE}`,          // H  REVENUE BY US
    `=H${row}/${OUR_SHARE}`,                   // I  PER PERSON BY US
    `=(D${row}+E${row}+F${row})*${THEIR_CUT}`, // J  REVENUE BY THEM
    `=G${row}*${THEIR_CUT}`,                   // K  BOT 2 REVENUE
    `=I${row}+J${row}+K${row}`,                // L  TOTAL PER PERSON
  ];
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

async function main() {
  const through = arg('through') || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return formatDate(d);
  })();
  const dates = datesBetween(startDate, through);
  if (dates.length === 0) throw new Error(`No dates between ${startDate} and ${through}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(ROOT, 'bots/bot-nitin/service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === SUMMARY);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SUMMARY } } }] },
    });
    console.log(`✅ Created tab "${SUMMARY}"`);
  } else {
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SUMMARY}!A2:A` });
    const rows = (cur.data.values || []).filter(r => r[0]).length;
    if (rows > 0 && !process.argv.includes('--force')) {
      console.error(`❌ "${SUMMARY}" already has ${rows} row(s). Re-run with --force to overwrite them.`);
      process.exit(1);
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUMMARY}!A1:L1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });

  // Column A goes in RAW so Sheets stores it as TEXT. That is load-bearing: the bots write
  // DD-MM-YYYY text into LOG, and SUMIFS only matches text against text. Let Sheets convert
  // these to real dates and every formula below returns 0 with no error to explain why.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUMMARY}!A2:A${dates.length + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: dates.map(d => [d]) },
  });

  // The formulas need USER_ENTERED to be parsed as formulas rather than stored as text.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUMMARY}!B2:L${dates.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: dates.map((_, i) => formulaRow(i + 2)) },
  });

  console.log(`✅ ${SUMMARY}: ${dates.length} rows, ${startDate} → ${through}`);
  console.log(`   https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
