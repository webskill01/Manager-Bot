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
    range: 'MEMBERS!A2:P',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  console.log(`   ✅ Read OK — ${rows.length} rows in ${Date.now() - started}ms\n`);
  process.exit(0);
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
    console.error(`\n   → PERMISSION. Share the sheet with ${sa.client_email} as Editor.`);
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
