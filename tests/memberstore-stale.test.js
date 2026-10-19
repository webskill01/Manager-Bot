import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStore } from '../core/memberStore.js';

// The panel writes renewals into the same sheet. A bot holding a stale cached row must not
// write that stale billing date back over the panel's renewal.
test('update re-reads the sheet so a stale cache cannot overwrite a newer row', async () => {
  let sheetRow = { rowIndex: 2, name: 'A', phone: '9876543210', billingDate: '19-10-2026', status: 'ACTIVE' };
  const written = [];
  const client = {
    getAll: async () => [{ ...sheetRow }],
    updateRow: async (_i, m) => { written.push(m); },
  };
  const store = createMemberStore(client, 'bot-x');
  await store.refresh();
  sheetRow = { ...sheetRow, billingDate: '19-11-2026' };   // panel renewed it meanwhile

  await store.update('9876543210', { callResult: 'x' });
  assert.equal(written[0].billingDate, '19-11-2026');
  assert.equal(written[0].callResult, 'x');
});
