import { normalizePhone } from '../../core/globalConfig.js';
import { liveOnApp } from '../../core/handlers/appHandlers.js';

// Pure. Every source → one Person per phone. The phone is the only identity in the panel,
// so a number can never show up twice (as a member AND as a fresh lead).
//
//   sheets     { bot: member[] }        rows as sheetClient.getAll() returns them
//   app        [{ phone, status, expiresAt, ... }]   EaseCab member-sync rows
//   allNumbers [[phone, name, ...]]     bot-nitin's ALL_NUMBERS tab, A:F, no header
//
// Person = { phone, name, members: [{bot, member}], active: [{bot, member}],
//            app, paidOnApp, lead: null | { exMember } }
// `lead` is set only for ALL_NUMBERS phones that are ACTIVE on no bot: those are the
// people still to pitch. exMember names their old bot(s) so a caller knows the history.
export function buildPeople({ sheets = {}, app = [], allNumbers = [], now = new Date().toISOString() }) {
  const people = new Map();
  const get = (raw) => {
    const phone = normalizePhone(raw ?? '');
    if (phone.length !== 10) return null;
    if (!people.has(phone)) people.set(phone, { phone, name: '', members: [], active: [], app: null, paidOnApp: false, lead: null });
    return people.get(phone);
  };

  for (const [bot, members] of Object.entries(sheets)) {
    for (const member of members) {
      const p = get(member.phone);
      if (!p) continue;
      p.members.push({ bot, member });
      if (member.status === 'ACTIVE') p.active.push({ bot, member });
    }
  }
  const leadNames = new Map();
  for (const [phone, name] of allNumbers) {
    const p = get(phone);
    if (p && name && !leadNames.has(p.phone)) leadNames.set(p.phone, String(name));
  }
  for (const row of app) {
    const p = people.get(normalizePhone(row.phone ?? ''));   // app-only users are nobody we call
    if (!p) continue;
    if (!p.app || (row.expiresAt || '') > (p.app.expiresAt || '')) p.app = row;
  }

  for (const p of people.values()) {
    p.paidOnApp = liveOnApp(p.app, now);
    p.name = (p.active[0] || p.members[0])?.member.name || leadNames.get(p.phone) || '';
    if (leadNames.has(p.phone) && !p.active.length) {
      p.lead = { exMember: p.members.map(({ bot, member }) => `${bot} (${member.status})`).join(', ') };
    }
  }
  return people;
}
