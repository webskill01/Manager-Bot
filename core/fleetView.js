import { createSheetClient } from './sheetClient.js';
import { normalizePhone, formatDate, friendlyDate } from './globalConfig.js';
import { TAB as GROUPS_TAB, fromTab } from './groupScan.js';

// Every bot's sheet, read-only, for the views that span the fleet (platform, today, applist,
// appstats and the combined payment ping on bot-nitin).
//
// Own sheet comes from the live store; the others come from FLEET_SHEETS in the .env
// ("bot-abhi=<id>,bot-sachin2=<id>"), read through the same service account, which all four
// bots share. Only getAll() is ever called on them — this module never writes another bot's
// sheet. A bot with no FLEET_SHEETS sees just itself, so every view degrades to "this sheet".
const CACHE_MS = 10 * 60 * 1000;   // ponytail: 10 min staleness for other sheets; their own bots own the writes

export const shortName = (bot) => String(bot).replace(/^bot-/, '');

// The combined bot-nitin ping for one app payment: who, how much, till when, and which
// sheets (if any) they sit on, and what to do. `where` is whereIs(phone), `own` this bot.
//   on no sheet      → maybe the person you just told to pay: add them, links come back
//   only other bots' → their member, their bot handles it: info only
export function paidPing(row, where, own = '') {
  const name = where.find(w => w.member.name)?.member.name || '(app user)';
  const till = row.expiresAt ? ` till ${friendlyDate(formatDate(new Date(row.expiresAt)))}` : '';
  const sheets = where.length
    ? where.map(({ bot, member }) => `${shortName(bot)} (${member.status})`).join(', ')
    : 'none — app only, not in any group sheet';
  const next = !where.length
    ? `\n   ➕ Yours? add [Name] ${row.phone}  → added as paid, links in the reply. Another bot's? Nothing to do.`
    : own && !where.some(w => w.bot === own)
      ? `\n   ℹ️ ${where.map(w => shortName(w.bot)).join('+')}'s member — their bot handles it, nothing to do.`
      : '';
  return `💳 App payment — ${name} (${row.phone})${row.lastAmount ? ` · ₹${row.lastAmount}` : ''}${till}\n   Sheets: ${sheets}${next}`;
}

// Each sheet also carries `inGroups` (Set of phones its bot last saw inside its WhatsApp
// groups): own from the live group scan, others from their GROUPS tab. Empty = not scanned.
export function createFleetView({ config, store, log, groupScan = null, sheet = null, makeClient = createSheetClient }) {
  const others = Object.entries(config.fleetSheets || {}).filter(([bot]) => bot !== config.botName);
  const clients = new Map();
  const cache = new Map();   // bot → { at, members, inGroups }

  async function readOther(bot, sheetId) {
    const hit = cache.get(bot);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    try {
      if (!clients.has(bot)) clients.set(bot, await makeClient(config.serviceAccountPath, sheetId, log));
      const c = clients.get(bot);
      const members = await c.getAll();
      const inGroups = new Set(c.readTab ? fromTab(await c.readTab(GROUPS_TAB).catch(() => [])).phones.keys() : []);
      const entry = { at: Date.now(), members, inGroups };
      cache.set(bot, entry);
      return entry;
    } catch (err) {
      log?.warn?.(`⚠️  Fleet: ${bot} sheet unreadable — ${err.message}`);
      return hit || { members: [], inGroups: new Set() };
    }
  }

  // → [{ bot, members, inGroups }], own sheet first.
  async function sheets() {
    const rest = await Promise.all(others.map(async ([bot, id]) => {
      const { members, inGroups } = await readOther(bot, id);
      return { bot, members, inGroups };
    }));
    return [{ bot: config.botName, members: store.getAll(), inGroups: new Set(groupScan?.phones().keys() || []) }, ...rest];
  }

  // → [{ bot, member }] for every sheet this phone is on.
  async function whereIs(phone) {
    const p = normalizePhone(phone);
    const out = [];
    for (const { bot, members } of await sheets()) {
      const m = members.find(x => x.phone === p);
      if (m) out.push({ bot, member: m });
    }
    return out;
  }

  return { sheets, whereIs, isFleet: others.length > 0, ownSheet: sheet };
}
