import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, randomBetween, sleep, formatDateTime } from './globalConfig.js';

// Who is actually inside this bot's paid WhatsApp groups, by phone — read, never changed.
//
// Ban safety: one groupMetadata per group (the same read a phone does when you open group
// info), 4–8 s apart, every 6 h at most. Nothing is sent. Commands read the cache, never
// WhatsApp, so `platform` spam cannot turn into metadata spam.
//
// The result goes to bots/<bot>/group-scan.json (survives restarts) and to a GROUPS tab in
// this bot's own sheet, which is how bot-nitin's fleet view sees the other bots' groups.
export const TAB = 'GROUPS';
export const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 10 * 60 * 1000;   // let the socket settle after a restart first

// LID-addressed groups report p.id as @lid; the paired phone JID rides on p.phoneNumber.
// → 10-digit phone, or '' when WhatsApp hid the number (unmatchable LID).
export function participantPhone(p) {
  const jid = p.phoneNumber || p.jid || p.id || '';
  if (!jid.endsWith('@s.whatsapp.net')) return '';
  const ph = normalizePhone(jid.replace('@s.whatsapp.net', '').replace(/\D/g, ''));
  return ph.length === 10 ? ph : '';
}

// GROUPS tab rows ⇄ Map phone → number of this bot's groups they are in.
export const toTab = (phones, at) => [['PHONE', 'GROUPS', `SCANNED ${at}`], ...[...phones].map(([p, n]) => [p, n])];
export function fromTab(rows) {
  const phones = new Map();
  for (const [p, n] of rows.slice(1)) { const ph = normalizePhone(String(p || '')); if (ph.length === 10) phones.set(ph, Number(n) || 1); }
  return { phones, at: String(rows[0]?.[2] || '').replace(/^SCANNED /, '') };
}

export function createGroupScan({ config, log, getSock, sheet, warmingUp = () => false }) {
  const file = path.join(config.botDir || '.', 'group-scan.json');
  let cache = { phones: new Map(), at: '', atMs: 0, hidden: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { phones: new Map(Object.entries(j.phones || {})), at: j.at || '', atMs: j.atMs || 0, hidden: j.hidden || 0 };
  } catch { /* first run */ }
  let running = false;

  async function scan() {
    if (running) return null;
    const sock = getSock();
    if (!sock?.user) { log.warn('👥 Group scan skipped — socket down'); return null; }
    if (warmingUp()) { log.info('🐣 Warm-up — skipped group scan'); return null; }
    running = true;
    try {
      const phones = new Map();
      let hidden = 0, ok = 0;
      for (let i = 0; i < config.paidGroups.length; i++) {
        try {
          const meta = await sock.groupMetadata(config.paidGroups[i]);
          ok++;
          for (const p of meta.participants || []) {
            const ph = participantPhone(p);
            if (ph) phones.set(ph, (phones.get(ph) || 0) + 1); else hidden++;
          }
        } catch (err) { log.warn(`⚠️  Group scan: group ${i + 1} failed — ${err.message}`); }
        if (i < config.paidGroups.length - 1) await sleep(randomBetween(4000, 8000));
      }
      // ponytail: any group failing keeps the old cache whole rather than writing a half list.
      if (ok < config.paidGroups.length) { log.warn(`👥 Group scan incomplete (${ok}/${config.paidGroups.length}) — kept the previous scan`); return null; }
      cache = { phones, at: formatDateTime(new Date()), atMs: Date.now(), hidden };
      fs.writeFileSync(file, JSON.stringify({ ...cache, phones: Object.fromEntries(phones) }));
      try { await sheet.writeTab(TAB, toTab(phones, cache.at)); }
      catch (err) { log.warn(`⚠️  Group scan: ${TAB} tab write failed — ${err.message}`); }
      log.info(`👥 Group scan — ${phones.size} phones in ${ok} group(s)${hidden ? `, ${hidden} hidden (LID)` : ''}`);
      return cache;
    } finally { running = false; }
  }

  // Boot: scan once the socket has settled, only if the last scan is stale. The 6-hourly
  // cron (scheduler) does the rest, so restarts never stack extra scans.
  function start() {
    setTimeout(() => { if (Date.now() - cache.atMs >= SCAN_EVERY_MS) scan().catch(err => log.warn(`⚠️  Group scan: ${err.message}`)); }, BOOT_DELAY_MS).unref?.();
  }

  return { scan, start, phones: () => cache.phones, at: () => cache.at, atMs: () => cache.atMs, hidden: () => cache.hidden };
}
