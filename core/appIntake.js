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

// Contact tag: only for people who are on a tagged bot's sheet and NOT on this bot's own
// (bot-abhi → ST, bot-sachin2 Malwa Travels → MT). A row this bot added during intake
// doesn't count as "own" — that's the moved user, still unique to the other bot.
export function tagFor(where, ownBot, tags, addedHere = false) {
  if (!addedHere && where.some(w => w.bot === ownBot)) return '';
  return where.map(w => tags[w.bot]).find(Boolean) || '';
}

// First word, letters only, capitalised: "gursewak singh" → "Gursewak", "Waheguruji 🙏" →
// "Waheguruji", "🙏🙏" → "". Contacts and new sheet rows use this.
export function firstName(raw) {
  const w = String(raw || '').replace(/[^\p{L}\p{M}\s]/gu, ' ').trim().split(/\s+/)[0] || '';
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

const REPLIES = ['Okk veerji 🙏', 'Ok paaji', 'Ok ji', 'Ji done 👍', 'Okk ji 🙏', 'Theek aa veerji'];
const textOf = (m) => m?.message?.conversation || m?.message?.extendedTextMessage?.text || '';
const phoneOfJid = (jid) => String(jid || '').endsWith('@s.whatsapp.net')
  ? normalizePhone(jid.split('@')[0].split(':')[0]) : null;

export function createAppIntake({ config, log, getSock, appSync, fleet, store, notify, afterTemplate = () => {} }) {
  const file = path.join(config.botDir, 'app-intake.json');
  const tags = config.contactTags || { 'bot-abhi': 'ST', 'bot-sachin2': 'MT' };
  const moveFrom = new Set(config.contactMoveFrom || ['bot-abhi']);   // users who move here; MT users stay on sachin
  const load = () => { try { return { contacts: {}, replied: {}, dms: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { contacts: {}, replied: {}, dms: {} }; } };
  const save = (st) => fs.writeFileSync(file, JSON.stringify(st, null, 2));

  async function saveContact(sock, senderPhone, fullName) {
    // WhatsApp-only contact: never written to the phone's own address book (operator's choice).
    await sock.addOrEditContact(`91${senderPhone}@s.whatsapp.net`, { fullName, firstName: fullName, saveOnPrimaryAddressbook: false });
  }

  const lastNote = new Map();   // app phone → "date|note" last sent to Telegram

  async function handle(msg) {
    if (msg?.key?.fromMe || !String(msg?.key?.remoteJid || '').match(/@(s\.whatsapp\.net|lid)$/)) return;
    const tpl = parseTemplate(textOf(msg));
    if (!tpl) return;
    const sender = phoneOfJid(msg.key.remoteJid) || phoneOfJid(msg.key.remoteJidAlt) || phoneOfJid(msg.key.senderPn);
    const st = load();
    // Who has DMed the template (app number + sender): the app gate approves only these.
    st.dms[tpl.phone] = todayStr();
    if (sender) st.dms[sender] = todayStr();
    save(st);

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

    const head = await intakeOne({ appPhone: tpl.phone, sender, name: tpl.name, profile: msg.pushName });
    // Same person resending the template: one Telegram note a day unless the result changed.
    if (lastNote.get(tpl.phone) !== `${todayStr()}|${head}`) { lastNote.set(tpl.phone, `${todayStr()}|${head}`); await notify(head); }
    afterTemplate();
  }

  // Has this number DMed the template (or been put through `intake` by the operator)?
  function hasDm(phone) {
    const st = load();
    return !!st.dms[phone] || !!st.contacts[phone] || Object.values(st.contacts).some(c => c.appPhone === phone);
  }

  // The intake steps for one person, after the template (or by hand: `intake`). sender = the
  // WhatsApp number whose chat it is (contact saved there). Returns the Telegram text.
  async function intakeOne({ appPhone, sender, name, profile }) {
    const lines = [];
    let row = null;
    try { row = await appSync.lookup(appPhone); }
    catch (err) { return `📥 ${appPhone} — app lookup failed (${err.message}), check by hand.`; }
    if (!sender) lines.push('⚠️ sender number hidden (LID) — contact not saved');
    else if (sender !== appPhone) lines.push(`⚠️ wrote from ${sender}, template says ${appPhone} — reminders go to the sheet number`);

    const where = fleet ? await fleet.whereIs(appPhone) : [];
    // App name (required at sign-up) → template name → a sheet name → WhatsApp profile name.
    name = [row?.name, name, ...where.map(w => w.member.name), profile].map(firstName).find(Boolean) || appPhone;
    if (!liveOnApp(row)) return `📥 ${name} (${appPhone}) — *not paid on the app* yet.\n${lines.join('\n')}`.trim();

    // bot-abhi users move here: reminders and removals from this bot's
    // numbers from now on; their old row goes MOVED so that bot leaves them alone.
    const own = where.some(w => w.bot === config.botName);
    const movable = where.filter(w => moveFrom.has(w.bot) && w.member.status !== 'MOVED');
    let added = !!load().contacts[sender || '']?.added;
    if (!own && (!where.length || movable.length)) {
      added = true;
      const until = appDate(row.expiresAt);
      await store.add({ name, phone: appPhone, joinDate: todayStr(), billingDate: until, appPaidUntil: until, paidLast: row.lastAmount ?? 0 });
      lines.push(`➕ added to ${config.botName} sheet (app till ${until})`);
    }
    for (const w of movable) {
      try { await fleet.setStatus(w.bot, appPhone, 'MOVED'); lines.push(`↪️ ${w.bot} row → MOVED`); }
      catch (err) { lines.push(`⚠️ ${w.bot} row not marked MOVED: ${err.message} — it may remind them too`); }
    }
    if (own || (where.length && !movable.length)) {
      lines.push(`on ${where.map(w => `${w.bot.replace(/^bot-/, '')} (${w.member.status})`).join(', ')}`);
    }

    const tag = tagFor(where, config.botName, tags, added);
    if (sender) {
      const full = contactName(name, row.expiresAt, tag);
      try {
        const sock = getSock();
        if (!sock) throw new Error('DM socket down');
        await saveContact(sock, sender, full);
        const now = load();
        now.contacts[sender] = { name, tag, appPhone, saved: full, added, at: formatDateTime(new Date()) };
        save(now);
        lines.push(`📇 saved as "${full}"`);
      } catch (err) { lines.push(`⚠️ contact not saved: ${err.message}`); }
    }
    return `📥 ${name} (${appPhone}) · live on app\n${lines.join('\n')}`;
  }

  // `intake` — people whose template came before the listener: one per line, "phone [name]".
  // Same steps as a template, minus the reply (you already answered them). 3–8 s apart.
  async function manual(text) {
    if (/^\s*retag\s*$/i.test(text)) return retag();
    const people = String(text || '').split('\n')
      .map(l => l.trim().match(/^(\+?[\d][\d\s-]{8,}?\d)(?:\s+(.+))?$/))
      .filter(Boolean)
      .map(m => ({ phone: normalizePhone(m[1].replace(/\D/g, '')), name: (m[2] || '').trim() }))
      .filter(p => p.phone.length === 10);
    if (!people.length) return 'Format (one per line): intake 9876543210 Name\nName is optional — the sheet name or the number is used.';
    const out = [];
    for (let i = 0; i < people.length; i++) {
      out.push(await intakeOne({ appPhone: people[i].phone, sender: people[i].phone, name: people[i].name }));
      if (i < people.length - 1) await new Promise(r => setTimeout(r, randomBetween(3000, 8000)));
    }
    afterTemplate();   // operator vouched for them → a waiting join request can go through
    return out.join('\n\n');
  }

  // `intake retag` — re-apply the tag rule to every saved contact, rename the ones that change.
  // Old records have no `added`: an own row joined the day of intake = added by intake.
  async function retag() {
    const st = load();
    const sock = getSock();
    if (!sock) return '⚠️ DM socket down — try again later.';
    const changed = [];
    for (const [sender, c] of Object.entries(st.contacts)) {
      const where = fleet ? await fleet.whereIs(c.appPhone) : [];
      const ownRow = where.find(w => w.bot === config.botName)?.member;
      const added = c.added ?? (!!ownRow && ownRow.joinDate === String(c.at).slice(0, 10));
      const tag = tagFor(where, config.botName, tags, added);
      c.added = added;
      // App name (required at sign-up) first, then the sheet name, then what was saved.
      let appName = '';
      try { appName = firstName((await appSync.lookup(c.appPhone))?.name); } catch { /* app down: keep the rest */ }
      const name = appName || firstName(ownRow?.name) || firstName(c.name) || c.name;
      const day = (c.saved.match(/ - (\d{2}) EC/) || [])[1];
      const full = day ? `${name} - ${day} EC${tag ? ` ${tag}` : ''}` : c.saved;
      if (full === c.saved) { c.tag = tag; continue; }
      try { await saveContact(sock, sender, full); changed.push(`${c.saved} → ${full}`); c.saved = full; c.tag = tag; c.name = name; }
      catch (err) { changed.push(`⚠️ ${c.saved}: ${err.message}`); }
      await new Promise(res => setTimeout(res, randomBetween(3000, 8000)));
    }
    save(st);
    const n = Object.keys(st.contacts).length;
    const count = (t) => Object.values(st.contacts).filter(c => c.tag === t).length;
    return `📇 ${n} intaken · ST ${count('ST')} · MT ${count('MT')}\n${changed.length ? changed.join('\n') : 'No tag changes.'}`;
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

  return { handle, onUpsert, onPaid, manual, hasDm };
}
