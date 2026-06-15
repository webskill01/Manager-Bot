import { google } from 'googleapis';
import { formatDateTime, normalizePhone, normalizeDateCell } from './globalConfig.js';

const SHEET_NAME = 'MEMBERS';
const DATA_RANGE = `${SHEET_NAME}!A2:O`;

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
  ];
}

export async function createSheetClient(serviceAccountPath, spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  async function getAll() {
    const res = await sheets.spreadsheets.values.get({
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
    });
    const rows = res.data.values || [];
    return rows.map((row, i) => rowToMember(row, i + 2));
  }

  async function appendRow(member) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:O`,
      valueInputOption: 'RAW',
      // INSERT_ROWS (not the API default OVERWRITE): always insert a brand-new row.
      // With OVERWRITE the API re-detects the "table" on every call and, when that
      // detection picks the wrong last row — or when two appends race — the new row
      // lands on top of the previous one, silently deleting the member just added.
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [memberToRow(member)] },
    });
  }

  async function updateRow(rowIndex, member) {
    const range = `${SHEET_NAME}!A${rowIndex}:O${rowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [memberToRow(member)] },
    });
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
      range: `${SHEET_NAME}!A:O`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: members.map(memberToRow) },
    });
  }

  return { getAll, appendRow, updateRow, clearData, batchAppend };
}
