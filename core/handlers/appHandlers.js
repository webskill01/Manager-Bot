import { normalizePhone, todayStr, formatDate, friendlyDate, chunkByChars, dateMatches } from '../globalConfig.js';
import { appDate } from '../appSync.js';
import { shortName } from '../fleetView.js';

// Commands for the EaseCab app era: platform, today, summary, revenue, appstats, applist.
//
// Three kinds of person, and every view splits by them:
//   App + groups — live app plan AND an ACTIVE row in at least one bot sheet
//   Groups only  — ACTIVE in a sheet, no live app plan (the old QR flow, transition month)
//   App only     — live app plan, in no bot sheet (app users who never joined the groups)
// The sheet tags ("nitin+abhi") say which bot sheets a person is on. On bot-nitin that spans
// all four sheets (FLEET_SHEETS); elsewhere it is just this bot's own sheet.
export const KINDS = [['both', '📱👥 App + groups'], ['groups', '👥 Groups only'], ['app', '📱 App only']];

const dayStart = (offset = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
const inDays = (n) => formatDate(dayStart(n));

export function liveOnApp(row, nowIso = new Date().toISOString()) {
  return !!row && row.status === 'active' && !!row.expiresAt && row.expiresAt > nowIso;
}

// Pure: one record per phone across every sheet plus the app snapshot.
//   → Map phone → { phone, name, bots: [short names, ACTIVE rows only], rows: [{bot, member}], app, kind }
export function buildPeople(sheets, appRows) {
  const people = new Map();
  const get = (phone) => {
    if (!people.has(phone)) people.set(phone, { phone, name: '', bots: [], rows: [], app: null });
    return people.get(phone);
  };
  for (const { bot, members } of sheets) {
    for (const m of members) {
      if (!m.phone) continue;
      const p = get(m.phone);
      p.rows.push({ bot, member: m });
      p.name = p.name || m.name;
      if (m.status === 'ACTIVE') p.bots.push(shortName(bot));
    }
  }
  for (const r of appRows) get(r.phone).app = r;
  for (const p of people.values()) {
    const app = liveOnApp(p.app);
    p.kind = app && p.bots.length ? 'both' : p.bots.length ? 'groups' : app ? 'app' : null;
  }
  return people;
}

// The date a person's current paid period ends: the app plan if live, else the sheet.
export function endsOn(p) {
  if (liveOnApp(p.app)) return appDate(p.app.expiresAt);
  return p.rows.find(r => r.member.status === 'ACTIVE')?.member.billingDate || '';
}

const label = (p) => `${p.name || '(app user)'} · ${p.phone}${p.bots.length ? ` · ${p.bots.join('+')}` : ''}`;

// "📱👥 App + groups (2)\n  • …" blocks for each non-empty kind.
export function splitBlock(list, line = label) {
  const out = [];
  for (const [kind, title] of KINDS) {
    const of = list.filter(p => p.kind === kind);
    if (of.length) out.push(`  ${title} (${of.length})\n${of.map(p => `    • ${line(p)}`).join('\n')}`);
  }
  return out.length ? out.join('\n') : '    —';
}

// ponytail: ISO stamps (lastUpdated) compare by UTC date; one stamped between midnight and 5:30 AM IST counts on the previous day.
const isOn = (stamp, day) => dateMatches(String(stamp || ''), day);

export function createAppHandlers({ config, appSync, client, fleet, log }) {
  const pooled = !!fleet?.isFleet;   // bot-nitin: the one place money is shown

  // Off bot-nitin a bot only counts its own sheet: app users on no row here are another
  // bot's (or nobody's), so they are left out of every view and count.
  async function people() {
    const sheets = fleet ? await fleet.sheets() : [];
    const all = buildPeople(sheets, [...appSync.snapshot().values()]);
    if (!pooled) for (const [phone, p] of all) if (!p.rows.length) all.delete(phone);
    return all;
  }

  // App payments this bot owns: all of them on bot-nitin, else only phones on this sheet.
  const own = (pays, byPhone) => pooled ? pays : pays.filter(x => byPhone.has(x.phone));

  async function paymentsSince(from, to = new Date()) {
    const res = await client.payments({ from, to });
    return res.payments;
  }

  async function handlePlatform(args) {
    const phone = normalizePhone((args || []).join(''));
    if (phone.length !== 10) return '❌ Format: platform [phone]';
    let row;
    try { row = await appSync.lookup(phone); }
    catch (err) { return `❌ Could not reach the app: ${err.message}`; }
    const p = buildPeople(fleet ? await fleet.sheets() : [], row ? [row] : []).get(phone)
      || { phone, rows: [], bots: [], app: null, kind: null };
    const app = !row ? '📱 App: never signed up'
      : liveOnApp(row) ? `📱 App: ACTIVE till ${friendlyDate(appDate(row.expiresAt))} · paid ${row.paidCount}×`
      : `📱 App: ${row.status}${row.expiresAt ? ` (ended ${friendlyDate(appDate(row.expiresAt))})` : ''}${row.paidCount ? ` · paid ${row.paidCount}×` : ''}`;
    const sheets = p.rows.length
      ? p.rows.map(({ bot, member: m }) => `   ${shortName(bot)}: ${m.name} · ${m.status} · billing ${m.billingDate || '—'}`).join('\n')
      : '   not in any bot sheet';
    const verdict = { both: '✅ App + groups', groups: '👥 Groups only — not paying on the app', app: '📱 App only — not in the groups' }[p.kind]
      || '❌ Neither — no live app plan, not active in any group';
    return `🔎 ${phone}\n${app}\n👥 Sheets:\n${sheets}\n\n${verdict}`;
  }

  // Everything about the day, split three ways.
  async function handleToday() {
    const byPhone = await people();
    const all = [...byPhone.values()].filter(p => p.kind);
    const today = todayStr();
    const ending = (n) => all.filter(p => endsOn(p) === inDays(n));
    let pays = [];
    try { pays = own(await paymentsSince(dayStart()), byPhone); }
    catch (err) { log?.warn?.(`⚠️  today: app payments unavailable — ${err.message}`); }
    const paidToday = uniq(pays.map(x => byPhone.get(x.phone) || { phone: x.phone, name: '', bots: [], kind: 'app' }));
    const groupsPaid = all.filter(p => p.kind === 'groups' && p.rows.some(r => isOn(r.member.lastRenewed, today)));
    const removed = [...byPhone.values()].filter(p => p.rows.some(r => r.member.status === 'REMOVED' && isOn(r.member.lastUpdated, today)));
    const removedLine = (p) => {
      const where = p.rows.filter(r => r.member.status === 'REMOVED' && isOn(r.member.lastUpdated, today)).map(r => shortName(r.bot));
      return `${p.name || p.phone} · ${p.phone} · from ${where.join('+')}${liveOnApp(p.app) ? ' (still on the app)' : ''}`;
    };
    return chunkByChars([
      `📅 TODAY — ${friendlyDate()}`,
      `⏳ Ends TODAY (${ending(0).length})\n${splitBlock(ending(0))}`,
      `⏳ Ends in 2 days (${ending(2).length})\n${splitBlock(ending(2))}`,
      `⏳ Ends in 5 days (${ending(5).length})\n${splitBlock(ending(5))}`,
      `💰 Paid today (${paidToday.length + groupsPaid.length})\n${splitBlock([...paidToday, ...groupsPaid])}`,
      `🚫 Removed today (${removed.length})\n${removed.length ? removed.map(p => `    • ${removedLine(p)}`).join('\n') : '    —'}`,
    ], undefined).map(c => c.join('\n\n'));
  }

  // Paid people only, same split. The evening report to the partners. `summary 1` = yesterday.
  async function handleSummary(args = []) {
    const back = Math.max(0, parseInt(args[0], 10) || 0);
    const today = inDays(-back);
    let pays = [];
    try { pays = await paymentsSince(dayStart(-back), back ? dayStart(1 - back) : new Date()); }
    catch (err) { return `❌ Could not reach the app: ${err.message}`; }
    const byPhone = await people();
    pays = own(pays, byPhone);
    const appPaid = uniq(pays.map(x => byPhone.get(x.phone) || { phone: x.phone, name: '', bots: [], kind: 'app' }));
    const groupsPaid = [...byPhone.values()].filter(p => p.kind === 'groups' && p.rows.some(r => isOn(r.member.lastRenewed, today)));
    const firsts = new Set(pays.filter(x => x.first).map(x => x.phone));
    const line = (p) => `${label(p)}${firsts.has(p.phone) ? ' · 🆕 first' : ''}`;
    const money = pooled ? `\n💵 App total: ₹${pays.reduce((s, x) => s + x.amount, 0)} (${pays.length} payment${pays.length === 1 ? '' : 's'})` : '';
    return `📊 PAID ${back ? '' : 'TODAY '}— ${friendlyDate(today)} · ${appPaid.length + groupsPaid.length} person(s)${money}\n\n` +
      splitBlock([...appPaid, ...groupsPaid], line);
  }

  // Pooled app revenue. No per-bot, per-partner or per-person split: one business, one total.
  async function handleRevenue(args = []) {
    if (!pooled) return 'ℹ️ Revenue is pooled across all bots and shown on bot-nitin only.';
    const span = String(args[0] || 'month').toLowerCase();
    const from = span === 'today' ? dayStart()
      : span === 'week' ? dayStart(-6)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let pays;
    try { pays = await paymentsSince(from); }
    catch (err) { return `❌ Could not reach the app: ${err.message}`; }
    const total = pays.reduce((s, x) => s + x.amount, 0);
    const firsts = pays.filter(x => x.first);
    const title = span === 'today' ? 'today' : span === 'week' ? 'last 7 days' : 'this month';
    return `💵 APP REVENUE — ${title}\n` +
      `   Total: ₹${total}\n` +
      `   Payments: ${pays.length} (🆕 ${firsts.length} first-time · 🔁 ${pays.length - firsts.length} renewals)\n` +
      `   QR payments are refunded and not counted.`;
  }

  async function handleAppStats() {
    const byPhone = await people();
    const all = [...byPhone.values()];
    const count = (k) => all.filter(p => p.kind === k).length;
    let week = [];
    try { week = own(await paymentsSince(dayStart(-6)), byPhone); } catch { /* counts still useful */ }
    const sheetLines = fleet ? (await fleet.sheets()).map(({ bot, members }) => {
      const active = members.filter(m => m.status === 'ACTIVE');
      const onApp = active.filter(m => liveOnApp(appSync.snapshot().get(m.phone))).length;
      const pending = members.filter(m => m.status === 'PENDING_APP').length;
      return `   ${shortName(bot)}: ${active.length} active · ${onApp} on app · ${active.length - onApp} not yet${pending ? ` · ${pending} pending` : ''}`;
    }).join('\n') : '';
    return `📱 APP STATS — ${friendlyDate()}\n` +
      `   App + groups: ${count('both')}\n   Groups only: ${count('groups')}\n   App only: ${count('app')}\n` +
      `${sheetLines ? `\nBy sheet:\n${sheetLines}\n` : ''}` +
      `\nLast 7 days: ${week.length} app payments (🆕 ${week.filter(x => x.first).length} first-time)` +
      (pooled ? ` · ₹${week.reduce((s, x) => s + x.amount, 0)}` : '');
  }

  async function handleAppList(args = []) {
    const want = { only: 'app', app: 'app', groups: 'groups', both: 'both' }[String(args[0] || '').toLowerCase()];
    if (!want) return '❌ Format: applist only | groups | both';
    const list = [...(await people()).values()].filter(p => p.kind === want)
      .sort((a, b) => (endsOn(a) && endsOn(b) ? dateKey(endsOn(a)) - dateKey(endsOn(b)) : 0));
    const title = KINDS.find(([k]) => k === want)[1];
    if (!list.length) return `${title}: nobody.`;
    const lines = list.map((p, i) => `${String(i + 1).padStart(3)}. ${label(p)} · ends ${endsOn(p) || '—'}`);
    return chunkByChars(lines).map((c, i) => `${i === 0 ? `${title} — ${list.length}\n\n` : ''}${c.join('\n')}`);
  }

  return { handlePlatform, handleToday, handleSummary, handleRevenue, handleAppStats, handleAppList };
}

function uniq(list) {
  const seen = new Set();
  return list.filter(p => !seen.has(p.phone) && seen.add(p.phone));
}

function dateKey(ddmmyyyy) {
  const [d, m, y] = String(ddmmyyyy).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
