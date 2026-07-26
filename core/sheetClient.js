import { google } from 'googleapis';
import { formatDateTime, normalizePhone, normalizeDateCell } from './globalConfig.js';

const SHEET_NAME = 'MEMBERS';
// A..P. Column P (callDate) was added for the tracker profile; it reads as '' on every
// existing sheet, so full-profile bots are unaffected and need no migration.
const DATA_RANGE = `${SHEET_NAME}!A2:P`;
const COL_RANGE = 'A:P';

function rowToMember(row, rowIndex) {
  return {
    rowIndex,
    name: row[0] || '',
    // Canonicalise to 10 digits at the boundary: cells may be number-typed (returned
    // unformatted as 7009686540 or 917009686540) or text. Normalising here means every
    // consumer — findByPhone matching, `91${phone}` JID building, display — sees the
    // same clean 10-digit string, and updateRow writes it back clean.
    phone: normalizePhone(row[1] || ''),
    // Date columns: tolerate cells Sheets auto-converted to real dates (numeric serials)
    // after a manual edit — normalizeDateCell coerces them back to DD-MM-YYYY text.
    joinDate: normalizeDateCell(row[2]),
    billingDate: normalizeDateCell(row[3]),
    status: String(row[4] || 'ACTIVE').trim().toUpperCase(),
    renewals: parseInt(row[5] || '0', 10),
    paidLast: parseInt(row[6] || '0', 10),
    reference: normalizePhone(row[7] || ''),
    skipReason: row[8] || '',
    addedBy: row[9] || '',
    lastUpdated: normalizeDateCell(row[10]),
    lastRenewed: normalizeDateCell(row[11]),
    refCreditDate: normalizeDateCell(row[12]),
    refLog: row[13] || '',
    delayUntil: normalizeDateCell(row[14]),
    // Tracker profile only: the date the operator called this member to pitch the app.
    callDate: normalizeDateCell(row[15]),
  };
}

function memberToRow(member) {
  return [
    member.name,
    member.phone,
    member.joinDate,
    member.billingDate,
    member.status,
    String(member.renewals),
    String(member.paidLast),
    member.reference || '',
    member.skipReason || '',
    member.addedBy || '',
    formatDateTime(new Date()),
    member.lastRenewed || '',
    member.refCreditDate || '',
    member.refLog || '',
    member.delayUntil || '',
    member.callDate || '',
  ];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sheets rate limits are per-minute (60 reads and 60 writes per user), so a burst — a
// bulk op, or a pm2 restart loop re-reading the sheet — gets 429s that clear on their own
// within a minute. Retrying with backoff turns a crash into a pause. Non-transient errors
// (bad credentials, wrong sheet id, malformed range) are thrown immediately: retrying
// those just delays the real error.
function isTransient(err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status === 429 || (Number(status) >= 500 && Number(status) < 600)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(err?.code)) return true;
  return /quota|rate limit|backend error|timeout|socket hang up/i.test(err?.message || '');
}

// Exported for tests only — the retry policy is the thing worth pinning down.
export { isTransient as __isTransientForTests };

export async function createSheetClient(serviceAccountPath, spreadsheetId, log = null) {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const RETRY_DELAYS = [2000, 5000, 15000, 40000, 60000];

  async function withRetry(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || attempt >= RETRY_DELAYS.length) throw err;
        const wait = RETRY_DELAYS[attempt];
        log?.warn?.(`⚠️  Sheets ${label} failed (${err.message.split('\n')[0]}) — retry ${attempt + 1}/${RETRY_DELAYS.length} in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }

  async function getAll() {
    const res = await withRetry('read', () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: DATA_RANGE,
      // UNFORMATTED_VALUE: return the raw cell value, not the display string.
      // A phone stored as a NUMBER (e.g. 917009686540) is otherwise returned by the
      // default FORMATTED_VALUE in scientific notation ("9.17009686540E+11") when the
      // column is too narrow to show every digit. normalizePhone() then strips the
      // ./E/+ and slices the wrong 10 digits, so the member can never be matched even
      // though the cell looks like a clean number. Reading unformatted keeps the full
      // numeric value intact; phone/date columns the bot writes are RAW text and pass
      // through unchanged.
      valueRenderOption: 'UNFORMATTED_VALUE',
    }));
    const rows = res.data.values || [];
    return rows.map((row, i) => rowToMember(row, i + 2));
  }

  async function appendRow(member) {
    await withRetry('append', () => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!${COL_RANGE}`,
      valueInputOption: 'RAW',
      // INSERT_ROWS (not the API default OVERWRITE): always insert a brand-new row.
      // With OVERWRITE the API re-detects the "table" on every call and, when that
      // detection picks the wrong last row — or when two appends race — the new row
      // lands on top of the previous one, silently deleting the member just added.
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [memberToRow(member)] },
    }));
  }

  async function updateRow(rowIndex, member) {
    const range = `${SHEET_NAME}!A${rowIndex}:P${rowIndex}`;
    await withRetry('update', () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [memberToRow(member)] },
    }));
  }

  async function clearData() {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: DATA_RANGE,
    });
  }

  async function batchAppend(members) {
    if (members.length === 0) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!${COL_RANGE}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: members.map(memberToRow) },
    });
  }

  // Update many rows in ONE API call. Sheets allows 60 write requests per minute per
  // user; a bulk op looping updateRow blows through that at ~60 members and the rest
  // silently fail (delayall/catchup hit exactly this with 98). batchUpdate collapses the
  // whole set into a single request regardless of size.
  async function batchUpdateRows(members) {
    if (members.length === 0) return;
    // Chunked only to keep any single request payload sane, not for quota.
    const CHUNK = 200;
    for (let i = 0; i < members.length; i += CHUNK) {
      const slice = members.slice(i, i + CHUNK);
      await withRetry('batchUpdate', () => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: slice.map(m => ({
            range: `${SHEET_NAME}!A${m.rowIndex}:P${m.rowIndex}`,
            values: [memberToRow(m)],
          })),
        },
      }));
    }
  }

  return { getAll, appendRow, updateRow, clearData, batchAppend, batchUpdateRows };
}
