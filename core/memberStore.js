import { normalizePhone } from './globalConfig.js';

export function createMemberStore(sheetClient, botName) {
  let members = [];

  async function refresh() {
    members = await sheetClient.getAll();
  }

  function findByPhone(phone) {
    const normalized = normalizePhone(phone);
    return members.find(m => normalizePhone(m.phone) === normalized) || null;
  }

  function findByName(name) {
    const lower = name.toLowerCase();
    return members.filter(m => m.name.toLowerCase().includes(lower));
  }

  function getAll() {
    return [...members];
  }

  function getActive() {
    return members.filter(m => m.status === 'ACTIVE');
  }

  async function add(memberData) {
    const member = {
      ...memberData,
      // Tracker-profile adds pass status: 'NEW' (start of the call funnel). Everything
      // else defaults to ACTIVE exactly as before.
      status: memberData.status || 'ACTIVE',
      renewals: 0,
      // ?? not || — addsilent passes paidLast: 0 as the "silent / not counted" flag.
      // With `|| 90` that intentional 0 was falsy and got overwritten to 90, so every
      // silent add was wrongly counted as a ₹90 new join in reports.
      paidLast: memberData.paidLast ?? 90,
      reference: memberData.reference || '',
      refCreditDate: memberData.refCreditDate || '',
      refLog: memberData.refLog || '',
      skipReason: '',
      addedBy: botName,
      lastUpdated: new Date().toISOString(),
    };
    await sheetClient.appendRow(member);
    await refresh();
    return findByPhone(member.phone);
  }

  // skipRefresh: bulk callers (delayall, catchup) update many rows in a loop and would
  // otherwise pay a full sheet read per member — 100 members = 200 API calls. They pass
  // skipRefresh and call refresh() once at the end. Returns null in that case, since the
  // in-memory copy is deliberately stale until that final refresh.
  async function update(phone, updates, { skipRefresh = false } = {}) {
    const member = findByPhone(phone);
    if (!member) throw new Error(`Member not found: ${phone}`);
    const updated = { ...member, ...updates, lastUpdated: new Date().toISOString() };
    await sheetClient.updateRow(member.rowIndex, updated);
    if (skipRefresh) return null;
    await refresh();
    return findByPhone(phone);
  }

  // Apply the SAME field updates to many members in one Sheets call. Use this for every
  // bulk op (delayall, catchup grace): looping `update` issues one write request per
  // member and Sheets caps writes at 60/minute per user, so a 98-member run silently
  // failed for everyone past the cap. Throws if the write fails — callers must not
  // report success on a partial apply.
  async function updateMany(phones, updates) {
    const rows = [];
    const missing = [];
    for (const phone of phones) {
      const member = findByPhone(phone);
      if (!member) { missing.push(phone); continue; }
      rows.push({ ...member, ...updates, lastUpdated: new Date().toISOString() });
    }
    if (rows.length > 0) await sheetClient.batchUpdateRows(rows);
    await refresh();
    return { updated: rows.length, missing };
  }

  async function initialize() {
    await refresh();
  }

  return { initialize, refresh, findByPhone, findByName, getAll, getActive, add, update, updateMany };
}
