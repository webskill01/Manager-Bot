#!/usr/bin/env node
// Standalone Google Sheets connectivity check — answers "is it quota, credentials,
// the sheet id, or the network?" without starting a bot or touching WhatsApp.
//
//   node scripts/check-sheets.js bot-nitin
//
// Read-only. Safe to run while a bot is stopped; it costs exactly one read request.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { COLUMNS } from '../core/sheetClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const botName = process.argv[2];
if (!botName) {
  console.error('Usage: node scripts/check-sheets.js <bot-name>');
  process.exit(2);
}

const botDir = path.join(ROOT, 'bots', botName);
const saPath = path.join(botDir, 'service-account.json');
const envPath = path.join(botDir, '.env');

function fail(msg, hint) {
  console.error(`\n❌ ${msg}`);
  if (hint) console.error(`   → ${hint}`);
  process.exit(1);
}

console.log(`\n🔍 Sheets check — ${botName}`);
console.log(`   Bot dir: ${botDir}`);

if (!fs.existsSync(botDir)) fail(`No such bot directory`, 'Check the bot name.');
if (!fs.existsSync(saPath)) fail(`service-account.json missing`, `Expected at ${saPath}`);

let sheetId = process.env.SHEET_ID || '';
if (!sheetId && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*SHEET_ID\s*=\s*(.+?)\s*$/);
    if (m) sheetId = m[1];
  }
}
if (!sheetId) fail('SHEET_ID not found', `Set it in ${envPath}`);

let sa;
try {
  sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
} catch (err) {
  fail(`service-account.json is not valid JSON: ${err.message}`, 'Re-download the key from Google Cloud.');
}
console.log(`   Service account: ${sa.client_email}`);
console.log(`   Sheet ID: ${sheetId}`);

// A JWT signed with a badly-skewed clock is rejected as invalid_grant, which reads like
// a credentials problem. Worth surfacing before blaming the key.
const skewSec = Math.abs(Date.now() - Date.parse(new Date().toUTCString())) / 1000;
if (skewSec > 60) console.log(`   ⚠️  System clock looks off by ~${Math.round(skewSec)}s`);

const started = Date.now();
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: saPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  console.log('   ✅ Auth OK');

  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'MEMBERS!A1:Q',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const [header = [], ...rows] = res.data.values || [];
  console.log(`   ✅ Read OK — ${rows.length} rows in ${Date.now() - started}ms`);

  // Read and write are separate permissions: a sheet shared with the service account as
  // VIEWER reads perfectly and 403s on every write, so a read-only check passes while
  // add/renewed/kick all fail at command time with "The caller does not have permission".
  // Probe it with a clear() of the tab's LAST row — always past the data, so it needs
  // write access but changes nothing. (A row past the grid would 400 as a bad range.)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
  const probeRow = meta.data.sheets.find(s => s.properties.title === 'MEMBERS')
    ?.properties.gridProperties.rowCount ?? rows.length + 1;
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `MEMBERS!A${probeRow}:Q${probeRow}`,
  });
  console.log('   ✅ Write OK — service account has Editor access');

  // Columns are positional and header text is cosmetic, so a misspelled label is harmless
  // while a column sitting in the wrong slot silently corrupts data. Reporting both as
  // "mismatch" buries the one that matters, so classify.
  const letter = i => String.fromCharCode(65 + i);
  const norm = s => String(s ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const known = new Set(COLUMNS);

  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }

  const critical = [];
  const cosmetic = [];
  for (let i = 0; i < COLUMNS.length; i++) {
    const want = COLUMNS[i];
    const got = norm(header[i]);
    if (got === want) continue;

    if (!got) {
      cosmetic.push(`   ${letter(i)}: ${want} — label missing (column is blank; just type the header in)`);
    } else if (known.has(got)) {
      critical.push(`   ${letter(i)}: expected ${want.padEnd(15)} found ${got}  ← SHIFTED, a real column is missing before this`);
    } else if (editDistance(got, want) <= 2 || want.startsWith(got) || got.startsWith(want)) {
      cosmetic.push(`   ${letter(i)}: ${want} is spelled "${got}" — typo only, data is in the right place`);
    } else {
      critical.push(`   ${letter(i)}: expected ${want.padEnd(15)} found ${got}  ← FOREIGN COLUMN, the bot WILL overwrite it`);
    }
  }

  if (header.length > COLUMNS.length) {
    console.log(`   ℹ️  ${header.length - COLUMNS.length} extra column(s) past Q — the bot never touches those, they are safe.`);
  }

  if (critical.length === 0 && cosmetic.length === 0) {
    console.log(`   ✅ Columns OK — all ${COLUMNS.length} headers A→Q match\n`);
    process.exit(0);
  }

  if (cosmetic.length > 0) {
    console.log(`\n⚠️  ${cosmetic.length} cosmetic issue(s) — nothing is broken, fix when convenient:`);
    console.log(cosmetic.join('\n'));
  }

  if (critical.length === 0) {
    console.log(`\n✅ Structure is CORRECT — every column is in the right position.\n`);
    process.exit(0);
  }

  console.error(`\n❌ ${critical.length} STRUCTURAL problem(s) — data is at risk:\n`);
  console.error(critical.join('\n'));
  console.error(`\n   Header has ${header.length} column(s), expected ${COLUMNS.length}.`);
  console.error('\n   → Rows are read AND WRITTEN positionally across A:Q. A missing column');
  console.error('     shifts every field after it with no error, and any foreign column in');
  console.error('     that range is overwritten the next time the bot updates that row.');
  console.error('\n   Expected order A→Q:');
  console.error('     ' + COLUMNS.map((c, i) => `${letter(i)}=${c}`).join('  '));
  console.error('\n   Fix by INSERTING the missing column in place. Keep your own extra');
  console.error('   columns at R or beyond — the bot never reads or writes past Q.\n');
  process.exit(1);
} catch (err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  console.error(`\n❌ Failed after ${Date.now() - started}ms`);
  console.error(`   Status: ${status}`);
  console.error(`   Message: ${err.message.split('\n')[0]}`);

  if (status === 429 || /quota|rate limit/i.test(err.message)) {
    console.error('\n   → QUOTA. Sheets allows 60 reads and 60 writes per minute per user.');
    console.error('     Stop the bot (pm2 stop <bot>), wait 2 minutes, run this again.');
    console.error('     A pm2 restart loop keeps re-consuming the quota — stop it first.');
  } else if (status === 403) {
    console.error('\n   → READ-ONLY SHEET. Reads work, every write fails. Two causes:');
    console.error('     1. The Drive account that OWNS this sheet is OUT OF STORAGE. Open the');
    console.error('        sheet — it shows "Storage is full. No edits can be made to this file."');
    console.error('        Free space in that account, or transfer the sheet to one with room.');
    console.error(`     2. The sheet is shared with ${sa.client_email}`);
    console.error('        as Viewer instead of Editor.');
    console.error('     Also check the Sheets API is enabled for the project.');
  } else if (status === 404) {
    console.error('\n   → NOT FOUND. SHEET_ID is wrong, or the sheet was deleted.');
  } else if (status === 400) {
    console.error('\n   → BAD RANGE. Is the tab named exactly "MEMBERS"?');
  } else if (/invalid_grant/i.test(err.message)) {
    console.error('\n   → CREDENTIALS or CLOCK. Check the VPS system time (timedatectl),');
    console.error('     then re-download the service account key.');
  } else {
    console.error('\n   → NETWORK. Try: curl -sS -o /dev/null -w "%{http_code}\\n" https://sheets.googleapis.com');
  }
  console.error('');
  process.exit(1);
}
