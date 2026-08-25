import fs from 'fs';
import path from 'path';
import { daysFromToday, normalizePhone as normPhone, getReferralsInBillingPeriod, todayStr, friendlyDate, sleep, isTracker } from './globalConfig.js';
import { createMemberHandlers } from './handlers/memberHandlers.js';
import { createRenewalHandlers } from './handlers/renewalHandlers.js';
import { createLookupHandlers } from './handlers/lookupHandlers.js';
import { createReportHandlers } from './handlers/reportHandlers.js';
import { createTrackerHandlers } from './handlers/trackerHandlers.js';
import { isConfigured, usesCloudApi, createCloudApiSender } from './cloudApiSender.js';
import { buildDmList, renderDmList } from './dmList.js';
import { renderSendLog } from './reminderSender.js';

let activeOverdueList = [];

// Commands that do real work (network calls / sheet writes / multi-group loops) BEFORE
// replying. handleMessage sends an instant "received" ack for these so the operator knows
// the command actually reached the bot during reconnect churn. Instant lookups
// (find/status/summary/stats/due/pending/refs/help/…) reply immediately and need no ack.
const SLOW_COMMANDS = new Set([
  'add', 'addsilent', 'addnew', 'approve', 'approveall', 'reject', 'rejectall',
  'kick', 'rejoin', 'sendlinks', 'links', 'refreshlinks', 'groupcheck', 'remind', 'renewed', 'advance',
  'warnall', 'kickall', 'notinsheet', 'leftmembers', 'stillin', 'kickghosts', 'diag',
  'dmlist', 'dmlist2', 'dmlist3', 'delayall', 'cloudapi', 'drip', 'ledger',
]);

// A Sheets 403 is a Google-side problem, not a bot problem, but its raw message ("The
// caller does not have permission") reads like the WhatsApp operator lacks rights and sends
// people hunting through allowedNumbers. Name the two causes that actually produce it —
// bot-abhi hit the storage one, which looks identical to a sharing mistake from the API.
export function sheetsHint(err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status !== 403 && !/caller does not have permission/i.test(err?.message || '')) return '';
  return '\n\n📊 The sheet is READ-ONLY for this bot. Two things do this:\n' +
         '  1. The Drive account that OWNS the sheet is out of storage — open the sheet,' +
         ' a "Storage is full" banner shows at the top. Free space or transfer ownership.\n' +
         '  2. The sheet is shared with the service account in service-account.json' +
         ' (client_email) as Viewer instead of Editor.\n' +
         'Verify with: node scripts/check-sheets.js <bot>';
}

export function isSlowCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  // Overdue batch actions (R1 S2 W3) remove/skip/warn members across all groups.
  if (/^([RSW]\d+\s*)+$/i.test(trimmed)) return true;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (SLOW_COMMANDS.has(cmd)) return true;
  if (cmd === 'start' && /^removal$/i.test(parts[1] || '')) return true;
  if (cmd === 'stop' && /^(removal|kickall|kickghosts)$/i.test(parts[1] || '')) return true;
  return false;
}

// Merge consecutive phone-part tokens at the start of args into one token.
// Phone parts: starts with + followed by digits, OR 3+ digit string.
// All other args (billing day 1-31, amount 45) are max 2 digits — no collision.
// Example: ['+91', '70158', '26065', '17'] → ['917015826065', '17']
// Example: ['91151', '18954', '17']        → ['9115118954', '17']
function mergePhoneFromStart(args) {
  if (args.length < 2) return args;
  const phoneParts = [];
  let i = 0;
  while (i < args.length && (/^\+\d+$/.test(args[i]) || /^\d{3,}$/.test(args[i]))) {
    phoneParts.push(args[i].replace(/\D/g, ''));
    i++;
  }
  if (phoneParts.length < 2) return args;
  return [phoneParts.join(''), ...args.slice(i)];
}

export function createCommandParser(store, groupManager, config, log, sock, botStartTime, trialEngine, removalEngine, ghostEngine, adminLids = new Set(), reminderSender = null, getSock = null, dripEngine = null, ledger = null) {
  const memberH = createMemberHandlers(store, groupManager, config, log);
  const renewalH = createRenewalHandlers(store, config, log);
  const lookupH = createLookupHandlers(store, config, log);
  const reportH = createReportHandlers(store, config, botStartTime, log, ledger);
  const trackerH = createTrackerHandlers(store, groupManager, config, log);
  const tracker = isTracker(config);
  // True when this bot has no WhatsApp socket at all — the operator commands it over
  // Telegram and every group action is theirs to perform by hand.
  const noWhatsApp = config.transport === 'telegram';

  // Renewal-era commands a tracker bot must never run — its operators don't collect
  // renewals at all, so silently doing nothing would be worse than saying so.
  const RENEWAL_ONLY = new Set([
    'renewed', 'advance', 'remind', 'dmlist', 'dmlist2', 'dmlist3', 'sent', 'due', 'overdue', 'refs', 'ref',
    'warnall', 'kickall', 'removal', 'forecast', 'collection',
    'norenew', 'toprefs', 'loyal', 'churn', 'upcoming', 'drip',
  ]);

  // Commands that read or mutate LIVE WhatsApp group state. A Telegram-operated bot holds
  // no WhatsApp connection at all, so these cannot work — and must not appear to. Left
  // ungated they'd hit manualGroupManager and throw, surfacing as a bare "Error processing
  // command"; refusing up front says what to do instead. Same shape as RENEWAL_ONLY above.
  const WHATSAPP_ONLY = new Map([
    ['approve',     'Approve join requests in WhatsApp, then log them here: add [Name] [phone]'],
    ['approveall',  'Approve join requests in WhatsApp, then log them here: add [Name] [phone]'],
    ['reject',      'Reject join requests in the WhatsApp group directly.'],
    ['rejectall',   'Reject join requests in the WhatsApp group directly.'],
    ['groupcheck',  'Open the group in WhatsApp and search the number. Sheet status: status [phone]'],
    ['notinsheet',  'Needs a live group roster. Compare by hand, or run this on the WhatsApp bot.'],
    ['leftmembers', 'Needs a live group roster. Compare by hand, or run this on the WhatsApp bot.'],
    ['stillin',     'Needs a live group roster. Compare by hand, or run this on the WhatsApp bot.'],
    ['kickghosts',  'Bulk group removal needs a WhatsApp connection. Remove them by hand.'],
    ['diag',        'Diagnostic for the WhatsApp socket — nothing to probe on Telegram.'],
    ['remind',      'This DMs the member a UPI QR over WhatsApp. Send it yourself, or use: dmlist'],
    // These three are engine-backed, and core/telegram.js constructs no engines — there is
    // no socket for them to drive. They were previously unreachable by accident: RENEWAL_ONLY
    // refused them while the friend bots were tracker-profile. Flipping those bots to full
    // removed that guard and they started answering with a bare null-pointer error, which
    // tells the operator nothing. Listed here so the refusal names the real reason.
    ['removal',     'The overdue list works without a socket — use: pending  (or: overdue)'],
    ['kickall',     'Bulk removal needs a WhatsApp connection. See who is due with `pending`, then remove them by hand.'],
    ['warnall',     'This DMs every overdue member. Send those yourself — `dmlist3` gives you one tap-to-send link each.'],
  ]);

  function whatsappOnly(cmd) {
    return `❌ "${cmd}" needs a live WhatsApp connection — this bot runs on Telegram.\n\n` +
      `👉 ${WHATSAPP_ONLY.get(cmd)}`;
  }

  // ── transport: "dual" ────────────────────────────────────────────────────────
  // bot-nitin keeps a WhatsApp socket for group ops AND takes commands over Telegram. The
  // socket can die under it — a 403 halts reconnects but the process keeps serving Telegram,
  // which is the entire point of running both. So "can this command work" is a question
  // about right now, not about configuration, and it has to be asked at dispatch time.
  const dual = config.transport === 'dual';
  const socketDown = () => dual && !getSock?.()?.user;

  const SOCKET_DOWN_BANNER =
    '⚠️ WhatsApp is DISCONNECTED — sheet commands work, group actions do not.\n' +
    '   Anything below about groups did not happen. Do it by hand in WhatsApp.';

  // Same refusal as the Telegram-only bots, different cause: there the socket was never
  // going to exist, here it existed and died. Naming the real reason is what stops an
  // operator hunting through allowedNumbers for a problem that is a dead connection.
  function socketDownOnly(cmd) {
    return `❌ "${cmd}" needs a live WhatsApp connection, and this bot's connection is DOWN.\n\n` +
      `👉 ${WHATSAPP_ONLY.get(cmd)}\n\n` +
      `Check why: pm2 logs ${config.botName} — a 403 means the number is flagged and reconnects are halted.`;
  }

  function trackerOnly(cmd) {
    return `❌ "${cmd}" is a tracker-profile command. This bot runs the full renewal profile.`;
  }

  function fullOnly(cmd) {
    return `❌ "${cmd}" isn't available on this bot — it tracks new joins and app moves, not renewals.\n` +
      `Try: pending · called [phone] · moved [phone] · calls · add · summary · revenue`;
  }

  // What actually went out today, from reminder-state.json. Meta's wamid per member is the
  // receipt: it means the API accepted the message and will deliver it. Failures carry Meta's
  // own reason and code, which is the difference between one bad number and a dead token.
  //
  // It does NOT prove the member's handset received or read it — that needs a delivery
  // webhook, which is deliberately a later phase. Say so rather than implying more.
  function handleSent() {
    if (!config.botDir) return '❌ botDir is not set — cannot read the reminder log.';
    const body = renderSendLog(config.botDir);
    if (!usesCloudApi(config)) {
      return `${body}\n\n` +
        `ℹ️ Reminders are in MANUAL mode — this log only fills up once reminderChannel is "cloudapi".\n` +
        `   Right now you send them yourself with: dmlist`;
    }
    return `${body}\n\n` +
      `ℹ️ A message id means Meta accepted it and will deliver it. Delivered/read receipts\n` +
      `   need the webhook, which isn't set up yet.`;
  }

  // The manual reminder path — prints one tap-to-send wa.me link per member with the text
  // pre-filled. Applies the 2-referral auto-renew first, so nobody who owes nothing ends up
  // on the list. Writes nothing else: the bot prints, the operator sends, so it cannot know
  // how far they got — any "stage" it recorded would be a guess.
  //
  // One command per wording, so each round is exactly the people who need that message:
  //   dmlist   due today   → msg1     dmlist2  5d overdue → msg2     dmlist3  6d only → msg3
  // The number is a DAY OF THE MONTH, not a window: `dmlist 27` is everyone billed on a 27th
  // and still unpaid, which is how a backlog gets worked in ~15-person batches. It used to
  // mean "the last N days" and returned 115+ people in one dump.
  async function handleDmList(args, cohort = 'due') {
    const cmd = cohort === 'nudge' ? 'dmlist2' : cohort === 'final' ? 'dmlist3' : 'dmlist';

    // `dmlist done` — "I have sent that batch, don't send to them again today". Checked
    // before the argument loop, which would otherwise reject `done` as a bad billing day.
    if (String(args[0] || '').toLowerCase() === 'done') {
      if (!dripEngine) return '❌ Nothing tracks the day on this bot.';
      return dripEngine.markShownHandled();
    }

    let billingDay = null;
    let force = null;
    for (const a of args) {
      const w = String(a).toLowerCase();
      if (/^\d{1,2}$/.test(w) && +w >= 1 && +w <= 31) billingDay = parseInt(w, 10);
      else if (/^msg[123]$/.test(w)) force = w;
      else return `❌ Unknown argument "${a}".\nUse: dmlist [1-31] [msg1|msg2|msg3]\n` +
        `  dmlist            due today\n` +
        `  dmlist2           ${config.overdue?.autoReminderDays ?? 5} days overdue (2nd message)\n` +
        `  dmlist3           ${config.overdue?.finalReminderDays ?? 6} days overdue (final notice)\n` +
        `  dmlist 27         everyone billed on the 27th, still unpaid\n` +
        `  dmlist 27 msg2    same batch, escalated wording\n` +
        `  dmlist done       mark the last list as sent by you today`;
    }

    // A date batch is its own thing — combining it with a cohort would ask for "billed on
    // the 27th AND exactly 5 days overdue", which is almost always nobody.
    if (billingDay !== null && cohort !== 'due') {
      return `❌ ${cmd} takes no date. For a specific billing day use:\n` +
        `  dmlist ${billingDay} ${cohort === 'nudge' ? 'msg2' : 'msg3'}`;
    }
    // Date batches are mostly people 20–30 days past due. Auto-escalating would hand nearly
    // all of them the final notice as their first contact of the round, so default to msg1
    // and make the operator escalate deliberately on a later pass.
    if (billingDay !== null && !force) force = 'msg1';

    if (!reminderSender) return `❌ ${cmd} not available on this bot.`;
    const renewed = await reminderSender.autoRenewDue(store, config.botDir);
    await store.refresh();
    const { rows, stageForced } = buildDmList({ members: store.getAll(), config, cohort, billingDay, force });
    const parts = renderDmList({ rows, stageForced, cohort, billingDay, config });

    // Recorded as SHOWN, never as sent — printing is not sending. `dmlist done` is what
    // promotes this to "handled today" and stops the bot messaging the same people.
    if (rows.length > 0) dripEngine?.rememberShown?.(rows.map(r => r.phone));

    if (renewed.length > 0) {
      parts[0] = `🎁 Auto-renewed (2 refs, no payment due): ` +
        `${renewed.map(m => m.name).join(', ')}\n\n` + parts[0];
    }
    return parts;
  }

  function isOverdueAction(text) {
    return /^([RSW]\d+\s*)+$/i.test(text.trim());
  }

  async function handleOverdueActions(text) {
    const actions = text.trim().toUpperCase().match(/[RSW]\d+/g) || [];
    if (activeOverdueList.length === 0) return '❌ No active overdue list. Send "overdue" first.';

    const results = [];
    for (const action of actions) {
      const type = action[0];
      const idx = parseInt(action.slice(1), 10) - 1;
      if (idx < 0 || idx >= activeOverdueList.length) {
        results.push(`❌ ${action}: invalid number`);
        continue;
      }
      const member = activeOverdueList[idx];
      if (type === 'R') {
        const reply = await memberH.handleKick([member.phone]);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'S') {
        const reply = await memberH.handleSkip([member.phone, 'overdue-skipped']);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'W') {
        if (!sock) {
          results.push(`${action}: ❌ Can't warn ${member.name} — no WhatsApp connection. Message them yourself.`);
          continue;
        }
        const msg = config.messages.overdue
          .replace('{name}', member.name)
          .replace('{days}', String(member.daysOverdue || 0));
        try {
          await sock.sendMessage(`91${member.phone}@s.whatsapp.net`, { text: msg });
          results.push(`${action}: ⚠️ Warning sent to ${member.name}`);
        } catch (err) {
          results.push(`${action}: ❌ Failed to send warning — ${err.message}`);
        }
      }
    }
    return results.join('\n');
  }

  // ── TEMP diagnostic: group ↔ sheet JID feasibility probe ─────────────────
  // Sweeps all paid groups, classifies every participant's JID, and reports
  // how many could actually be matched against the sheet. Throwaway command —
  // used to decide how reliable a "members not in sheet" audit can be.
  async function handleDiag() {
    const members = store.getAll();
    const sheetPhones = new Set(members.map(m => normPhone(m.phone)));
    // Auto-resolved admin LIDs (from allowedNumbers) + config.allowedLids manual fallback
    const allowedLids = new Set([
      ...adminLids,
      ...(config.allowedLids || []).map(l => String(l).split(':')[0]),
    ]);

    let total = 0, phoneJid = 0, lidJid = 0, otherJid = 0;
    let phoneInSheet = 0, phoneNotInSheet = 0;
    let lidOwnAdmin = 0, lidWithPhoneField = 0, lidPhoneMatched = 0, lidUnresolvable = 0;
    let sampleKeys = null;
    const perGroup = [];

    for (let i = 0; i < config.paidGroups.length; i++) {
      const groupId = config.paidGroups[i];
      let meta;
      try {
        meta = await sock.groupMetadata(groupId);
      } catch (err) {
        perGroup.push(`• ${groupId.slice(0, 10)}… → ERR ${err.message}`);
        continue;
      }
      const parts = meta.participants || [];
      if (!sampleKeys && parts.length) sampleKeys = Object.keys(parts[0]);

      let gPhone = 0, gLid = 0, gMiss = 0;
      for (const p of parts) {
        total++;
        const jid = p.jid || p.id || '';
        // Some Baileys builds attach the real phone to LID participants here
        const phoneField = p.phoneNumber || p.jid || '';
        if (jid.endsWith('@s.whatsapp.net')) {
          phoneJid++; gPhone++;
          const ph = normPhone(jid.replace('@s.whatsapp.net', '').replace(/\D/g, ''));
          if (sheetPhones.has(ph)) phoneInSheet++;
          else { phoneNotInSheet++; gMiss++; }
        } else if (jid.endsWith('@lid')) {
          lidJid++; gLid++;
          const raw = jid.replace('@lid', '').split(':')[0];
          if (allowedLids.has(raw)) { lidOwnAdmin++; continue; }
          // Can we recover a phone for this LID from any field?
          const recovered = String(phoneField).includes('@s.whatsapp.net')
            ? normPhone(String(phoneField).replace('@s.whatsapp.net', '').replace(/\D/g, ''))
            : null;
          if (recovered) {
            lidWithPhoneField++;
            if (sheetPhones.has(recovered)) lidPhoneMatched++;
            else { phoneNotInSheet++; gMiss++; }
          } else {
            lidUnresolvable++;
          }
        } else {
          otherJid++;
        }
      }
      perGroup.push(`• ${(meta.subject || groupId).slice(0, 22)}: ${parts.length}p | 📱${gPhone} 🆔${gLid} | ${gMiss} not-in-sheet`);
      if (i < config.paidGroups.length - 1) await sleep(1200);
    }

    // Probe pending join-request JID formats (decides if approve-by-phone works)
    let pendTotal = 0, pendPhone = 0, pendLid = 0, pendPhoneField = 0;
    let pendErr = null;
    try {
      const pend = await groupManager.getAllPendingRequests();
      for (const g of pend) {
        for (const p of g.pending) {
          pendTotal++;
          const j = String(p.jid || p.id || '');
          if (j.endsWith('@s.whatsapp.net')) pendPhone++;
          else if (j.endsWith('@lid')) pendLid++;
          if (String(p.phoneNumber || '').includes('@s.whatsapp.net')) pendPhoneField++;
        }
      }
    } catch (e) { pendErr = e.message; }

    const lines = [
      '🔬 *DIAG — group vs sheet*',
      '',
      `Groups swept: ${config.paidGroups.length}`,
      `Total participants: ${total}`,
      '',
      `📱 Phone JIDs: ${phoneJid}  (in sheet ${phoneInSheet}, not ${phoneNotInSheet})`,
      `🆔 LID JIDs: ${lidJid}`,
      `   ├ own/admin (whitelisted): ${lidOwnAdmin}`,
      `   ├ had recoverable phone: ${lidWithPhoneField} (matched sheet ${lidPhoneMatched})`,
      `   └ UNRESOLVABLE: ${lidUnresolvable}`,
      otherJid ? `❔ Other JID format: ${otherJid}` : null,
      '',
      `Sample participant fields: ${sampleKeys ? sampleKeys.join(', ') : 'n/a'}`,
      '',
      pendErr
        ? `Pending requests: scan failed — ${pendErr}`
        : `Pending requests: ${pendTotal} (📱${pendPhone} 🆔${pendLid}, phoneNumber-field ${pendPhoneField})`,
      '',
      '*Per group:*',
      ...perGroup,
    ].filter(Boolean);
    return lines.join('\n');
  }

  // Short label for a group: leading "N." from its name (groups are named
  // "1.DELHI ONLY…"), else fall back to its 1-based position.
  function groupLabel(subject, idx) {
    const m = /^(\d+)\./.exec(subject || '');
    return m ? m[1] : String(idx + 1);
  }

  // Numbers never flagged in audits: command senders, group owners, the bot.
  function auditExcludeSet() {
    const exclude = new Set([
      ...(config.allowedNumbers || []),
      ...(config.auditExclude || []),
    ].map(normPhone));
    const selfRaw = (sock?.user?.id || '').split(':')[0].replace(/\D/g, '');
    if (selfRaw) exclude.add(normPhone(selfRaw));
    return exclude;
  }

  // Scan the given groups once → Map<phone10, Set<groupLabel>> of every phone-JID
  // participant. Shared by notinsheet / leftmembers / stillin so the group sweep
  // is written once. Returns scanned count and any per-group errors too.
  async function scanPresence(targets) {
    const presence = new Map();
    let scanned = 0;
    const errors = [];
    for (let t = 0; t < targets.length; t++) {
      const { id: groupId, i } = targets[t];
      let meta;
      try {
        meta = await sock.groupMetadata(groupId);
      } catch (err) {
        errors.push(`#${i + 1}: ${err.message}`);
        continue;
      }
      scanned++;
      const label = groupLabel(meta.subject, i);
      for (const p of (meta.participants || [])) {
        // LID-addressed groups report p.id as @lid; the paired phone JID rides on p.phoneNumber
        const jid = p.phoneNumber || p.jid || p.id || '';
        if (!jid.endsWith('@s.whatsapp.net')) continue; // LID/unknown — can't match
        const ph = normPhone(jid.replace('@s.whatsapp.net', '').replace(/\D/g, ''));
        if (!ph || ph.length < 10) continue;
        if (!presence.has(ph)) presence.set(ph, new Set());
        presence.get(ph).add(label);
      }
      if (t < targets.length - 1) await sleep(1200);
    }
    return { presence, scanned, errors };
  }

  // List members present in the WhatsApp group(s) but absent from the sheet.
  // Deduplicates by phone across all groups; excludes admins + the bot itself.
  // Usage: "notinsheet" (all groups) or "notinsheet 3" (only group #3).
  async function handleNotInSheet(args) {
    const sheetPhones = new Set(store.getAll().map(m => normPhone(m.phone)));
    const exclude = auditExcludeSet();

    let targets = config.paidGroups.map((id, i) => ({ id, i }));
    if (args[0] && /^\d+$/.test(args[0])) {
      const n = parseInt(args[0], 10);
      if (n < 1 || n > config.paidGroups.length) {
        return `❌ Group number must be 1–${config.paidGroups.length}.`;
      }
      targets = [{ id: config.paidGroups[n - 1], i: n - 1 }];
    }
    const single = targets.length === 1;

    const { presence, scanned, errors } = await scanPresence(targets);

    const rows = [...presence.entries()]
      .filter(([ph]) => !sheetPhones.has(ph) && !exclude.has(ph))
      .map(([ph, grps]) => ({ ph, grps: [...grps].sort((a, b) => Number(a) - Number(b)) }))
      .sort((a, b) => b.grps.length - a.grps.length || a.ph.localeCompare(b.ph));

    if (rows.length === 0) {
      return `✅ Every member is in the sheet. (${scanned} group${scanned === 1 ? '' : 's'} scanned)`;
    }

    const header = single
      ? `👻 *Not in sheet* — group #${targets[0].i + 1} — ${rows.length} number${rows.length === 1 ? '' : 's'}`
      : `👻 *Not in sheet* — ${rows.length} unique number${rows.length === 1 ? '' : 's'} across ${scanned} groups`;

    const lines = [header, ''];
    rows.forEach((r, idx) => {
      const grpStr = single ? '' : ` — ${r.grps.length} grp${r.grps.length > 1 ? 's' : ''}: ${r.grps.join(',')}`;
      lines.push(`${idx + 1}. ${r.ph}${grpStr}`);
    });
    if (errors.length) lines.push('', `⚠️ ${errors.length} group(s) failed: ${errors.join(' | ')}`);
    lines.push('', 'Add: addsilent [Name] [phone]  •  Remove: kick [phone]');
    return lines.join('\n');
  }

  // ACTIVE members in the sheet who are no longer in ANY group (silently left).
  async function handleLeftMembers() {
    const active = store.getActive();
    const { presence, scanned, errors } = await scanPresence(config.paidGroups.map((id, i) => ({ id, i })));

    const gone = active
      .filter(m => !presence.has(normPhone(m.phone)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (gone.length === 0) {
      return `✅ All ${active.length} ACTIVE members are present in groups. (${scanned} scanned)`;
    }

    const lines = [`🚪 *Left but ACTIVE* — ${gone.length} of ${active.length} active members not in any group`, ''];
    gone.forEach((m, i) => lines.push(`${i + 1}. ${m.name} • ${m.phone}`));
    if (errors.length) {
      lines.push('', `⚠️ ${errors.length} group(s) failed to scan — list may be overstated: ${errors.join(' | ')}`);
    }
    lines.push('', 'Verify: groupcheck [phone]  •  Remove from sheet: kick [phone]');
    return lines.join('\n');
  }

  // Members marked REMOVED in the sheet who are STILL physically in a group.
  async function handleStillIn() {
    const removed = store.getAll().filter(m => m.status === 'REMOVED');
    const { presence, scanned, errors } = await scanPresence(config.paidGroups.map((id, i) => ({ id, i })));

    const rows = removed
      .map(m => ({ m, grps: presence.get(normPhone(m.phone)) }))
      .filter(x => x.grps && x.grps.size > 0)
      .map(x => ({ name: x.m.name, phone: x.m.phone, grps: [...x.grps].sort((a, b) => Number(a) - Number(b)) }))
      .sort((a, b) => b.grps.length - a.grps.length);

    if (rows.length === 0) {
      return `✅ No REMOVED member is still in a group. (${scanned} scanned)`;
    }

    const lines = [`👻 *REMOVED but still in group* — ${rows.length}`, ''];
    rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name} • ${r.phone} — ${r.grps.length} grp${r.grps.length > 1 ? 's' : ''}: ${r.grps.join(',')}`));
    if (errors.length) lines.push('', `⚠️ ${errors.length} group(s) failed: ${errors.join(' | ')}`);
    lines.push('', 'Re-remove: kick [phone]');
    return lines.join('\n');
  }

  // Preview of the bulk ghost removal. "kickghosts confirm" starts the engine.
  async function handleKickGhostsPreview() {
    const running = ghostEngine.status();
    if (running) return `⚠️ Ghost removal already running — ${running.done}/${running.total} done. Send "stop kickghosts" to cancel.`;

    const sheetPhones = new Set(store.getAll().map(m => normPhone(m.phone)));
    const exclude = auditExcludeSet();
    const { presence, scanned, errors } = await scanPresence(config.paidGroups.map((id, i) => ({ id, i })));

    const ghosts = [...presence.keys()].filter(ph => !sheetPhones.has(ph) && !exclude.has(ph));
    if (ghosts.length === 0) {
      return `✅ No ghosts found — every member is in the sheet. (${scanned} scanned)`;
    }

    const avgGapMin = 22; // midpoint of 15–30
    const estHours = ((ghosts.length - 1) * avgGapMin / 60).toFixed(1);
    let msg = `🚫 *Ghost removal — preview*\n`;
    msg += `${ghosts.length} number(s) are in groups but not in the sheet.\n`;
    msg += `Removal runs 1 person at a time, 15–30 min apart (~${estHours} hrs total).\n`;
    if (errors.length) msg += `⚠️ ${errors.length} group(s) failed to scan — those members excluded.\n`;
    msg += `\n👉 Send *kickghosts confirm* to start.\n(See the full list first with: notinsheet)`;
    return msg;
  }

  async function parse(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (isOverdueAction(trimmed)) {
      return handleOverdueActions(trimmed);
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (tracker && RENEWAL_ONLY.has(cmd)) return fullOnly(cmd);
    if (noWhatsApp && WHATSAPP_ONLY.has(cmd)) return whatsappOnly(cmd);
    // Dual transport with the socket down. Only the WHATSAPP_ONLY set is refused outright,
    // because those are pure group reads/writes with no sheet effect to salvage. kick, add,
    // rejoin, sendlinks and kickall all write the sheet BEFORE (or regardless of) the group
    // work, so they still run and still record the truth — the banner explains what didn't
    // happen. Refusing them would cost the one thing that matters when the number is banned.
    if (socketDown() && WHATSAPP_ONLY.has(cmd)) return socketDownOnly(cmd);
    // "start removal" / "stop kickall" — the engines behind these drive group sends and
    // group kicks over the socket, so they're refused on the same grounds as the list above.
    if ((noWhatsApp || socketDown()) && (cmd === 'start' || cmd === 'stop') && /^(removal|kickall|kickghosts)$/i.test(args[0] || '')) {
      const why = noWhatsApp ? 'this bot runs on Telegram' : "this bot's WhatsApp connection is DOWN";
      return `❌ "${cmd} ${args[0].toLowerCase()}" drives WhatsApp group operations — ${why}.\n\n` +
        `👉 Do the removals by hand in WhatsApp, then record each one here: kick [phone]`;
    }

    // Pattern: "[phone] ref [refPhone]" — handles both compact and spaced formats:
    // "9876543210 ref 9876543211"  or  "+91 98765 43210 ref +91 98765 43211"
    const refPos = parts.findIndex(p => p.toLowerCase() === 'ref');
    const isPhonePart = p => /^\+\d+$/.test(p) || /^\d{3,}$/.test(p);
    if (refPos > 0 && refPos < parts.length - 1 && parts.slice(0, refPos).every(isPhonePart)) {
      const memberPhone = parts.slice(0, refPos).map(p => p.replace(/\D/g, '')).join('');
      const afterRef = parts.slice(refPos + 1); // preserve 'prev'/'backdate' flags
      try { return await memberH.handleRef([memberPhone, 'ref', ...afterRef]); }
      catch (err) {
        log.error(`❌ Handler error for ref command: ${err.message}`);
        return `❌ Error processing command: ${err.message}`;
      }
    }

    // Every case below is `return handler(...)`, not `return await handler(...)` — the
    // promise leaves the try block before it settles, so an async handler's rejection
    // NEVER reaches the catch. It escaped to the messages.upsert handler instead, which
    // only logs: the operator saw total silence (a Sheets 403 on `addnew` looked like the
    // bot ignoring them). Awaiting the whole switch through this wrapper routes every
    // case's failure back into the catch, so the operator always gets an answer.
    const dispatch = async () => {
      switch (cmd) {
        case 'add':        return memberH.handleAdd(args);
        case 'addsilent':  return memberH.handleSilentAdd(args);
        // Deleted: `add` no longer sends anything, so the two commands became the same
        // operation. Kept as a named case rather than falling through to "Unknown command"
        // because the muscle memory is real. addsilent stays — it differs on paidLast: 0,
        // which keeps an existing member out of join revenue.
        case 'addnew':
          return `❌ \`addnew\` is gone — \`add\` no longer sends anything, so it does the same job.\n\n` +
                 `add [Name] [phone]        →  new paying member (counts as join revenue)\n` +
                 `addsilent [Name] [phone]  →  existing member, NOT counted as a new join`;
        case 'kick':       return memberH.handleKick(mergePhoneFromStart(args));
        case 'skip':       return memberH.handleSkip(mergePhoneFromStart(args));
        case 'unskip':     return memberH.handleUnskip(mergePhoneFromStart(args));
        case 'delay':      return memberH.handleDelay(mergePhoneFromStart(args));
        case 'delayall':   return memberH.handleDelayAll(args);
        case 'approve':
          if (args.length > 0) return memberH.handleApprovePhone(mergePhoneFromStart(args));
          return memberH.handleApproveAll();
        case 'approveall': return memberH.handleApproveAll();
        case 'reject':
          if (args.length > 0) return memberH.handleRejectPhone(mergePhoneFromStart(args));
          return memberH.handleRejectAll();
        case 'rejectall':  return memberH.handleRejectAll();
        case 'links':      return memberH.handleLinks(mergePhoneFromStart(args));
        case 'refreshlinks': return memberH.handleRefreshLinks();
        case 'setlink':    return memberH.handleSetLink(args);
        case 'sendlinks':  return memberH.handleSendLinks(mergePhoneFromStart(args));
        case 'rejoin':     return memberH.handleRejoin(mergePhoneFromStart(args));
        case 'groupcheck': return memberH.handleGroupCheck(mergePhoneFromStart(args));

        // Tracker profile has no renewals, so `pending` means the CALL list instead of
        // the overdue-payment list. Every other renewal command is refused outright
        // rather than silently doing nothing.
        // `pending` means OVERDUE everywhere, on every profile.
        //
        // It used to mean the call list on tracker bots and the overdue list on full ones.
        // Once the friend bots went back to collecting renewals they needed both meanings at
        // once, and one word cannot carry two. Overdue wins because it is the money question,
        // and nothing is lost: `log` already prints a "NOT CALLED YET (N) — M due now"
        // bucket, which is exactly what tracker `pending` used to show.
        case 'pending':    return renewalH.handlePending();
        // Call tracking is no longer tracker-only. A full bot still collects renewals AND
        // still pitches the app, so refusing these on profile would take away work the
        // friend bots actually do. They read and write column Q, which every profile has.
        case 'called':     return trackerH.handleCalled(mergePhoneFromStart(args));
        case 'log':
        case 'calls':      return trackerH.handleLog();
        // Retired: the bot never marked anyone converted well, and removing them was the
        // operator's call anyway. Kept as an explicit hint because the muscle memory is real.
        // Retired on EVERY profile, not gated on one. It was profile-gated back when call
        // tracking was tracker-only; now that a full bot pitches the app too, answering
        // "that's a tracker command" would be doubly wrong — it is not a tracker command,
        // it is not a command at all.
        case 'moved':
          return `❌ "moved" is gone — this bot only logs the pitch, it doesn't move or remove anyone.\n\n` +
            `Log what they said:  called ${normPhone(mergePhoneFromStart(args)[0] || '') || '[phone]'} interested\n` +
            `Want the seat back:  kick ${normPhone(mergePhoneFromStart(args)[0] || '') || '[phone]'}\n` +
            `See everything:      log`;

        case 'renewed':    return renewalH.handleRenewed(mergePhoneFromStart(args));
        case 'advance':    return renewalH.handleAdvance(mergePhoneFromStart(args));
        case 'due':        return renewalH.handleDue(args);
        case 'overdue': {
          const result = renewalH.handleOverdue();
          activeOverdueList = store.getActive()
            .filter(m => daysFromToday(m.billingDate) !== null && daysFromToday(m.billingDate) < 0)
            .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
            .sort((a, b) => b.daysOverdue - a.daysOverdue);
          return result;
        }
        case 'refs':       return memberH.handleRefs(mergePhoneFromStart(args));

        case 'find':       return lookupH.handleFind(args);
        case 'status':     return lookupH.handleStatus(mergePhoneFromStart(args));

        case 'digest':     return reportH.handleMorningDigest();
        case 'summary':    return reportH.handleSummary(args);
        case 'stats':      return reportH.handleStats();
        case 'revenue':    return reportH.handleRevenue();
        case 'groups':     return reportH.handleGroups();
        case 'removed':    return reportH.handleRemovedList();
        case 'skipped':    return reportH.handleSkippedList();
        case 'ping':       return reportH.handlePing(sock);
        case 'help':       return reportH.handleHelp(args);

        case 'upcoming':   return reportH.handleUpcoming(args);
        case 'toprefs':    return reportH.handleTopRefs();
        case 'loyal':      return reportH.handleLoyal(args);
        case 'growth':     return reportH.handleGrowth();
        case 'forecast':   return reportH.handleForecast();
        case 'trend':      return reportH.handleTrend();
        case 'churn':      return reportH.handleChurn();
        case 'norenew':    return reportH.handleNoRenew();
        case 'collection': return reportH.handleCollection();
        case 'tenure':     return reportH.handleTenure();
        case 'weekly':     return reportH.handleWeekly();
        case 'monthly':    return reportH.handleMonthly(args);
        case 'audit':      return reportH.handleAudit();
        case 'diag':       return handleDiag();
        case 'notinsheet': return handleNotInSheet(args);
        case 'leftmembers':return handleLeftMembers();
        case 'stillin':    return handleStillIn();
        case 'kickghosts':
          if (args[0]?.toLowerCase() === 'confirm') return ghostEngine.start();
          return handleKickGhostsPreview();

        case 'remind': {
          const phone = normPhone(mergePhoneFromStart(args)[0] || '');
          if (phone.length !== 10) return '❌ Format: remind [phone]';
          const member = store.findByPhone(phone);
          if (!member) return `❌ No member found for ${args[0] || phone}. Try: find [name]`;
          if (member.status !== 'ACTIVE') return `⚠️ ${member.name} is ${member.status} — remind only works for ACTIVE members.`;
          const all = store.getAll();
          const refs = getReferralsInBillingPeriod(member.phone, member.billingDate, all).length;
          if (refs >= 2) return `ℹ️ ${member.name} has ${refs} refs — they'll be auto-renewed, no reminder needed.`;
          const type = refs === 1 ? 'referral' : 'normal';
          const template = (type === 'referral' && config.messages.referralReminder)
            ? config.messages.referralReminder : config.messages.reminder;
          const caption = template.replace('{name}', member.name).replace('{date}', friendlyDate(member.billingDate));
          const jid = `91${member.phone}@s.whatsapp.net`;
          try {
            const qrPath = config.upiQrPath ? path.resolve(config.botDir, config.upiQrPath) : null;
            if (qrPath && fs.existsSync(qrPath)) {
              const image = fs.readFileSync(qrPath);
              await sock.sendMessage(jid, { image, caption });
            } else {
              await sock.sendMessage(jid, { text: caption });
            }
            const amount = refs === 1 ? config.renewal.referralAmount : config.renewal.fullAmount;
            return `✅ Reminder sent to ${member.name} (${member.phone}) — ₹${amount}`;
          } catch (err) {
            return `❌ Failed to send reminder: ${err.message}`;
          }
        }

        case 'dmlist':   return handleDmList(args, 'due');
        case 'dmlist2':  return handleDmList(args, 'nudge');
        case 'dmlist3':  return handleDmList(args, 'final');

        // Proof of today's reminders, on demand. On the Cloud API the operator never sees
        // the messages themselves — this and the per-batch Telegram report are the only
        // evidence, so it reads the same record the batch report renders.
        case 'sent':     return handleSent();

        // The drip pushes tap-to-send links to Telegram on a timer so the operator sends
        // them by hand, spaced out, instead of remembering to run `dmlist` and then firing
        // a whole day's reminders in one sitting.
        case 'drip': {
          if (!dripEngine) {
            return '⚠️ Drip unavailable — it needs a Telegram listener, and this bot has none.\n' +
                   'Add TELEGRAM_TOKEN to this bot\'s .env and restart. Meanwhile: dmlist';
          }
          const sub = (args[0] || '').toLowerCase();
          if (sub === 'stop')  return dripEngine.stop();
          if (sub === 'start') return dripEngine.start();
          if (sub === 'test')  return dripEngine.test();
          // `plan` / `today` / `schedule` — the day in advance, so a healthy run and a stuck
          // one stop looking the same from the outside. Read-only.
          if (sub === 'plan' || sub === 'today' || sub === 'schedule') return dripEngine.plan();
          return dripEngine.status();
        }

        // The shared revenue ledger. It writes itself at 10 PM and again at 5 AM, so these
        // are for checking on it and for the first backfill — not part of anyone's routine.
        case 'ledger': {
          if (!ledger?.enabled) {
            return `📒 Ledger is off — add a "ledger" block with a spreadsheetId and startDate\n` +
                   `to bots/${config.botName}/config.json, restart, and share that sheet with this bot's service account.`;
          }
          const sub = (args[0] || '').toLowerCase();
          const report = (r) => `✅ Ledger synced — ${r.dates} date(s): ${r.appended} added, ${r.updated} corrected.`;
          if (sub === 'now')  return report(await ledger.writeToday());
          if (sub === 'sync' || sub === 'backfill') return report(await ledger.reconcile());
          return ledger.status();
        }

        case 'removal':    return removalEngine.handleRemoval();
        case 'warnall':    return removalEngine.warnall();
        case 'kickall':    return removalEngine.kickall();

        // Verify the official API end-to-end before flipping reminderChannel on the
        // whole bot — a template rejection or a bad token should surface here, not at
        // 10 AM against real members.
        case 'cloudapi': {
          if (!isConfigured(config)) {
            return '❌ Cloud API not configured. Add to config.json:\n' +
              '"reminderChannel": "cloudapi",\n' +
              '"cloudApi": { "phoneNumberId": "...", "token": "...", "templateName": "...", "languageCode": "en" }';
          }
          const active = usesCloudApi(config);
          if (!/^test$/i.test(args[0] || '')) {
            return `☁️ Cloud API configured.\nChannel: ${active ? 'cloudapi (ACTIVE)' : 'group/dm (configured but NOT active)'}\n` +
              `Template: ${config.cloudApi.templateName}\n\nSend a real test: cloudapi test [phone]`;
          }
          const phone = normPhone(mergePhoneFromStart(args.slice(1))[0] || '');
          if (phone.length !== 10) return '❌ Format: cloudapi test [phone]';
          const sender = createCloudApiSender(config, log);
          const res = await sender.sendTemplate({ phone, bodyParams: ['Test', '1', todayStr()] });
          return res.ok
            ? `✅ Cloud API test sent to ${phone}.\nMessage id: ${res.messageId}\nChannel is ${active ? 'ACTIVE' : 'configured but NOT active — set reminderChannel to "cloudapi"'}.`
            : `❌ Cloud API test failed: ${res.error}${res.code ? ` [code ${res.code}]` : ''}`;
        }

        case 'start':
          if (args[0]?.toLowerCase() === 'removal') return trialEngine.start();
          return `❓ Unknown command. Did you mean "start removal"?`;
        case 'stop':
          if (args[0]?.toLowerCase() === 'removal') return trialEngine.stopCommand();
          if (args[0]?.toLowerCase() === 'kickall') return removalEngine.stopKickall();
          if (args[0]?.toLowerCase() === 'kickghosts') return ghostEngine.stop();
          return `❓ Unknown command. Did you mean "stop removal", "stop kickall", or "stop kickghosts"?`;

        default:
          return `❓ Unknown command: "${cmd}". Send 'help' for full list.`;
      }
    };

    try {
      const out = await dispatch();
      // On "dual" with a dead socket every reply is half-true: the sheet write landed, the
      // group half did not. One banner says which half, rather than auditing forty handlers
      // for wording that assumes a live connection — `add` in particular reports "13 failed
      // — check if number is on WhatsApp" when the real cause is this bot's own socket.
      if (socketDown() && out) {
        const parts = Array.isArray(out) ? [...out] : [out];
        parts[0] = `${SOCKET_DOWN_BANNER}\n\n${parts[0]}`;
        return Array.isArray(out) ? parts : parts[0];
      }
      return out;
    } catch (err) {
      log.error(`❌ Handler error for cmd "${cmd}": ${err.message}`);
      const banner = socketDown() ? `${SOCKET_DOWN_BANNER}\n\n` : '';
      return `${banner}❌ Error processing command: ${err.message}${sheetsHint(err)}`;
    }
  }

  function setOverdueList(list) {
    activeOverdueList = list;
  }

  // Run a report the way an operator would type it, and hand back one string.
  //
  // The restored morning/evening digest crons call this rather than reaching into the
  // handlers directly, so the scheduled report and the typed command can never drift apart
  // — that drift is how `digest` and the old cron ended up computing different sets.
  // Array replies (chunked reports) are joined; Telegram's own splitter handles length.
  async function runReport(cmd) {
    const out = await parse(cmd);
    return Array.isArray(out) ? out.join('\n\n') : out;
  }

  return { parse, setOverdueList, runReport };
}
