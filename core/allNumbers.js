import { normalizePhone } from './globalConfig.js';
import { appDate } from './appSync.js';
import { liveOnApp } from './handlers/appHandlers.js';

// bot-nitin's ALL_NUMBERS tab: every phone any bot knows, one row each, with three columns
// the bot keeps current so the sheet can be filtered by app status:
//   G ON APP (YES/NO) · H APP TILL (plan end) · I IN GROUPS (bots whose WhatsApp groups have them)
// A–F are the operator's (PHONE, NAME, SOURCE SHEETS, SHEET COUNT, INTERESTED, STATUS): kept
// as read for existing rows, filled for new ones. New = on any sheet, in any group, or live on
// the app, and not in the tab yet.
export const TAB = 'ALL_NUMBERS';
const APP_HEAD = ['ON APP', 'APP TILL', 'IN GROUPS'];
const BASE = 6;   // A–F
const pad = (r) => Array.from({ length: BASE }, (_, i) => r?.[i] ?? '');

const appCols = (p) => p
  ? [liveOnApp(p.app) ? 'YES' : 'NO', p.app?.expiresAt ? appDate(p.app.expiresAt) : '', p.groups.join('+')]
  : ['NO', '', ''];

// Pure. rows = the tab as read (A:F, header first); people = buildPeople(...) across the fleet.
export function buildAllNumbers(rows, people) {
  const [header, ...body] = rows;
  const out = [[...pad(header?.length ? header : ['PHONE', 'NAME', 'SOURCE SHEETS (status)', 'SHEET COUNT', 'INTERESTED', 'STATUS']), ...APP_HEAD]];
  const seen = new Set();
  for (const r of body) {
    const phone = normalizePhone(String(r[0] ?? ''));
    seen.add(phone);
    out.push([...pad(r), ...appCols(people.get(phone))]);
  }
  let added = 0;
  for (const p of people.values()) {
    if (seen.has(p.phone) || !(p.rows.length || p.groups.length || liveOnApp(p.app))) continue;
    const src = p.rows.map(({ bot, member }) => `${bot} (${member.status})`).join(', ') || 'not in any sheet';
    const status = p.bots.length ? 'ACTIVE' : p.groups.length ? 'IN GROUPS' : p.rows.length ? (p.rows[0].member.status || '') : 'APP ONLY';
    out.push([p.phone, p.name, src, p.rows.length, '', status, ...appCols(p)]);
    added++;
  }
  return { rows: out, added };
}
