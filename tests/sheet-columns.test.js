import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';

// sheetClient builds rows positionally; the mapping is the contract worth pinning.
test('sheetClient spans A2:Q and maps callResult to column Q (index 16)', () => {
  const src = fs.readFileSync(new URL('../core/sheetClient.js', import.meta.url), 'utf8');
  assert.match(src, /A2:Q/, 'DATA_RANGE must span through Q');
  assert.match(src, /COL_RANGE = 'A:Q'/, 'COL_RANGE must span through Q');
  assert.match(src, /callResult:\s*String\(row\[16\]/, 'callResult reads row[16]');
  assert.match(src, /A\$\{rowIndex\}:Q\$\{rowIndex\}/, 'updateRow writes through Q');
  assert.match(src, /A\$\{m\.rowIndex\}:Q\$\{m\.rowIndex\}/, 'batchUpdateRows writes through Q');
});
