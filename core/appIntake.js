import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, randomBetween, todayStr, formatDateTime } from './globalConfig.js';
import { liveOnApp } from './appFlow.js';
import { appDate } from './appSync.js';

// The join-request template app users send to the DM number ("…join request bhej di hai…
// Name: X / Number: 98…", also in Punjabi and Hindi). Their message opens the chat from their
// side, which is what makes the bot's later reminder DMs safe. On each template:
//   • a short "ok ji" reply, 1–5 min later (variants), once per person per day
//   • paid + running on the app → saved as a contact "Name - DD EC" (DD = app expiry day,
//     + " ST" when they are on bot-abhi's sheet), and added to this bot's sheet when they are
//     on no sheet — that row is what the expiry-day and day-after reminders go to
//   • one Telegram line per person; template number ≠ sender number is flagged
// Anything that is not the template is ignored. Renewals rename the contact to the new day.

// [ \t] not \s: an empty "Name:" must not swallow the next line.
const NAME_RE = /(?:^|\n)[ \t]*(?:name|ਨਾਮ|नाम)[ \t]*[:：][ \t]*([^\n]*)/i;
const NUM_RE = /(?:^|\n)[ \t]*(?:number|ਨੰਬਰ|नंबर)[ \t]*[:：][ \t]*([+\d][\d \t-]{8,})/i;

export function parseTemplate(text) {
  const num = String(text || '').match(NUM_RE);
  if (!num) return null;
  const phone = normalizePhone(num[1].replace(/\D/g, ''));
  if (phone.length !== 10) return null;
  const name = (String(text).match(NAME_RE)?.[1] || '').trim();
  return { name, phone };
}

// "Yatin Sadana", 2026-12-16 → "Yatin Sadana - 16 EC"; tag ST → "… - 16 EC ST"
export function contactName(name, expiresAt, tag = '') {
  const day = appDate(expiresAt).slice(0, 2);
  return `${String(name).trim()} - ${day} EC${tag ? ` ${tag}` : ''}`;
}

const REPLIES = ['Okk veerji 🙏', 'Ok paaji', 'Ok ji', 'Ji done 👍', 'Okk ji 🙏', 'Theek aa veerji'];
const textOf = (m) => m?.message?.conversation || m?.message?.extendedTextMessage?.text || '';
const phoneOfJid = (jid) => String(jid || '').endsWith('@s.whatsapp.net')
  ? normalizePhone(jid.split('@')[0].split(':')[0]) : null;

export function createAppIntake({ config, log, getSock, appSync, fleet, store, notify }) {
  const file = path.join(config.botDir, 'app-intake.json');
  const tags = config.contactTags || { 'bot-abhi': 'ST' };
  const load = () => { try { return { contacts: {}, replied: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { contacts: {}, replied: {} }; } };
  const save = (st) => fs.writeFileSync(file, JSON.stringify(st, null, 2));

  async function saveContact(sock, senderPhone, fullName) {
    // WhatsApp-only contact: never written to the phone's own address book (operator's choice).
    await sock.addOrEditContact(`91${senderPhone}@s.whatsapp.net`, { fullName, firstName: fullName, saveOnPrimaryAddressbook: false });
  }

  async function handle(msg) {
    if (msg?.key?.fromMe || !String(msg?.key?.remoteJid || '').match(/@(s\.whatsapp\.net|lid)$/)) return;
    const tpl = parseTemplate(textOf(msg));
    if (!tpl) return;
    const sender = phoneOfJid(msg.key.remoteJid) || phoneOfJid(msg.key.remoteJidAlt) || phoneOfJid(msg.key.senderPn);
    const st = load();
    const lines = [];

    // Reply first (in their chat, whatever the app says), at most once a day per person.
    const replyKey = sender || msg.key.remoteJid;
    if (st.replied[replyKey] !== todayStr()) {
      st.replied[replyKey] = todayStr();
      save(st);
      const jid = msg.key.remoteJid;
      setTimeout(async () => {
        try { await getSock()?.sendMessage(jid, { text: REPLIES[randomBetween(0, REPLIES.length - 1)] }); }
        catch (err) { log.warn(`⚠️  Intake reply failed: ${err.message}`); }
      }, randomBetween(60_000, 300_000)).unref?.();
    }

    let row = null;
    try { row = await appSync.lookup(tpl.phone); }
    catch (err) { await notify(`📥 Template from ${tpl.phone} — app lookup failed (${err.message}), check by hand.`); return; }
    if (!sender) lines.push('⚠️ sender number hidden (LID) — contact not saved');
    else if (sender !== tpl.phone) lines.push(`⚠️ wrote from ${sender}, template says ${tpl.phone} — reminders go to the sheet number`);

    const name = tpl.name || msg.pushName || tpl.phone;
    if (!liveOnApp(row)) {
      await notify(`📥 ${name} (${tpl.phone}) sent the join template — *not paid on the app* yet.\n${lines.join('\n')}`.trim());
      return;
    }

    const where = fleet ? await fleet.whereIs(tpl.phone) : [];
    const tag = where.map(w => tags[w.bot]).find(Boolean) || '';
    // Tagged bots' users (bot-abhi → ST) move here: reminders and removals from this bot's
    // numbers from now on; their old row goes MOVED so that bot leaves them alone.
    const own = where.some(w => w.bot === config.botName);
    const movable = where.filter(w => tags[w.bot] && w.member.status !== 'MOVED');
    if (!own && (!where.length || movable.length)) {
      const until = appDate(row.expiresAt);
      await store.add({ name, phone: tpl.phone, joinDate: todayStr(), billingDate: until, appPaidUntil: until, paidLast: row.lastAmount ?? 0 });
      lines.push(`➕ added to ${config.botName} sheet (app till ${until})`);
    }
    for (const w of movable) {
      try { await fleet.setStatus(w.bot, tpl.phone, 'MOVED'); lines.push(`↪️ ${w.bot} row → MOVED`); }
      catch (err) { lines.push(`⚠️ ${w.bot} row not marked MOVED: ${err.message} — it may remind them too`); }
    }
    if (own || (where.length && !movable.length)) {
      lines.push(`on ${where.map(w => `${w.bot.replace(/^bot-/, '')} (${w.member.status})`).join(', ')}`);
    }

    if (sender) {
      const full = contactName(name, row.expiresAt, tag);
      try {
        const sock = getSock();
        if (!sock) throw new Error('DM socket down');
        await saveContact(sock, sender, full);
        const now = load();
        now.contacts[sender] = { name, tag, appPhone: tpl.phone, saved: full, at: formatDateTime(new Date()) };
        save(now);
        lines.push(`📇 saved as "${full}"`);
      } catch (err) { lines.push(`⚠️ contact not saved: ${err.message}`); }
    }
    await notify(`📥 ${name} (${tpl.phone}) opened chat · live on app\n${lines.join('\n')}`);
  }

  // App payment rows (appSync onAppPaid): rename saved contacts to the new expiry day.
  async function onPaid(rows) {
    const st = load();
    const sock = getSock();
    if (!sock) return;
    for (const r of rows) {
      const appPhone = normalizePhone(String(r.phone));
      for (const [sender, c] of Object.entries(st.contacts)) {
        if (c.appPhone !== appPhone || !r.expiresAt) continue;
        const full = contactName(c.name, r.expiresAt, c.tag);
        if (full === c.saved) continue;
        try { await saveContact(sock, sender, full); c.saved = full; log.info(`📇 Contact ${sender} → "${full}"`); }
        catch (err) { log.warn(`⚠️  Contact rename ${sender} failed: ${err.message}`); }
        await new Promise(res => setTimeout(res, randomBetween(3000, 8000)));
      }
    }
    save(st);
  }

  const onUpsert = ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages || []) handle(m).catch(err => log.warn(`⚠️  Intake: ${err.message}`));
  };

  return { handle, onUpsert, onPaid };
}
