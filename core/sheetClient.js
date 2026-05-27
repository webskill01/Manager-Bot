import { google } from 'googleapis';
import { formatDateTime } from './globalConfig.js';

const SHEET_NAME = 'MEMBERS';
const DATA_RANGE = `${SHEET_NAME}!A2:N`;

function rowToMember(row, rowIndex) {
  return {
    rowIndex,
    name: row[0] || '',
    phone: row[1] || '',
    joinDate: row[2] || '',
    billingDate: row[3] || '',
    status: (row[4] || 'ACTIVE').trim().toUpperCase(),
    renewals: parseInt(row[5] || '0', 10),
    paidLast: parseInt(row[6] || '0', 10),
    reference: row[7] || '',
    skipReason: row[8] || '',
    addedBy: row[9] || '',
    lastUpdated: row[10] || '',
    lastRenewed: row[11] || '',
    refCreditDate: row[12] || '',
    refLog: row[13] || '',
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
    });
    const rows = res.data.values || [];
    return rows.map((row, i) => rowToMember(row, i + 2));
  }

  async function appendRow(member) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:N`,
      valueInputOption: 'RAW',
      requestBody: { values: [memberToRow(member)] },
    });
  }

  async function updateRow(rowIndex, member) {
    const range = `${SHEET_NAME}!A${rowIndex}:N${rowIndex}`;
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
      range: `${SHEET_NAME}!A:L`,
      valueInputOption: 'RAW',
      requestBody: { values: members.map(memberToRow) },
    });
  }

  return { getAll, appendRow, updateRow, clearData, batchAppend };
}
