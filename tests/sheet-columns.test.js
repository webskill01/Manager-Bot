import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { COLUMNS } from '../core/sheetClient.js';

// Rows are read and written positionally, so this list IS the data contract. A column
// omitted from a real sheet shifts every field after it and nothing throws — which is
// exactly what happened to a live sheet that was missing DELAY_UNTIL.
test('COLUMNS is the canonical A→Q order and matches rowToMember exactly', () => {
  assert.deepEqual(COLUMNS, [
    'NAME', 'PHONE', 'JOIN_DATE', 'BILLING_DATE', 'STATUS', 'RENEWALS', 'PAID_LAST',
    'REFERENCE', 'SKIP_REASON', 'ADDED_BY', 'LAST_UPDATED', 'LAST_RENEWED',
    'REF_CREDIT_DATE', 'REF_LOG', 'DELAY_UNTIL', 'CALL_DATE', 'CALL_RESULT',
  ]);
  assert.equal(COLUMNS.length, 17, 'A through Q');
  assert.equal(COLUMNS.indexOf('DELAY_UNTIL'), 14, 'O');
  assert.equal(COLUMNS.indexOf('CALL_DATE'), 15, 'P');
  assert.equal(COLUMNS.indexOf('CALL_RESULT'), 16, 'Q');
});

test('check-sheets validates the header against COLUMNS', () => {
  const src = fs.readFileSync(new URL('../scripts/check-sheets.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ COLUMNS \}/, 'must use the one source of truth');
  assert.match(src, /MEMBERS!A1:Q/, 'must read the header row and span to Q');
  // A misspelled header is cosmetic; a column in the wrong slot corrupts data. The
  // checker must not report them at the same severity.
  assert.match(src, /STRUCTURAL problem/, 'reports structural damage loudly');
  assert.match(src, /cosmetic issue/, 'reports typos separately');
  assert.match(src, /SHIFTED/, 'detects a known column in the wrong position');
  assert.match(src, /FOREIGN COLUMN/, 'detects an operator column inside the bot range');
});

// sheetClient builds rows positionally; the mapping is the contract worth pinning.
test('sheetClient spans A2:Q and maps callResult to column Q (index 16)', () => {
  const src = fs.readFileSync(new URL('../core/sheetClient.js', import.meta.url), 'utf8');
  assert.match(src, /A2:Q/, 'DATA_RANGE must span through Q');
  assert.match(src, /COL_RANGE = 'A:Q'/, 'COL_RANGE must span through Q');
  assert.match(src, /callResult:\s*String\(row\[16\]/, 'callResult reads row[16]');
  assert.match(src, /A\$\{rowIndex\}:Q\$\{rowIndex\}/, 'updateRow writes through Q');
  assert.match(src, /A\$\{m\.rowIndex\}:Q\$\{m\.rowIndex\}/, 'batchUpdateRows writes through Q');
});
