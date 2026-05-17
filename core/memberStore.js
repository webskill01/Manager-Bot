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
      status: 'ACTIVE',
      renewals: 0,
      paidLast: memberData.paidLast || 90,
      reference: memberData.reference || '',
      skipReason: '',
      addedBy: botName,
      lastUpdated: new Date().toISOString(),
    };
    await sheetClient.appendRow(member);
    await refresh();
    return findByPhone(member.phone);
  }

  async function update(phone, updates) {
    const member = findByPhone(phone);
    if (!member) throw new Error(`Member not found: ${phone}`);
    const updated = { ...member, ...updates, lastUpdated: new Date().toISOString() };
    await sheetClient.updateRow(member.rowIndex, updated);
    await refresh();
    return findByPhone(phone);
  }

  async function initialize() {
    await refresh();
  }

  return { initialize, refresh, findByPhone, findByName, getAll, getActive, add, update };
}
