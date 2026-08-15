import {
  normalizePhone, todayStr, parseDate, daysFromToday,
  isCallDue, needsFollowUp, chunkByChars, UNCALLED_STATUSES,
} from '../globalConfig.js';

// Tracker profile only. The operator gathers new joins, then calls each person once
// they've been in the group a month to pitch the app.
//
// The bot ONLY keeps the log: who is due a call, that a call happened, on what date, and
// what the person said. It does not mark anyone as converted and it never removes anyone
// from a group — moving someone onto the app happens outside the bot, and the operator
// kicks them by hand (`kick [phone]`) if and when they want the seat back.
//
// Lifecycle: NEW → CALLED, with callResult '' | 'interested' | 'not-interested'.
export function createTrackerHandlers(store, groupManager, config, log) {
  const callAfterDays = config.tracker?.callAfterDays ?? 30;
  const followUpDays = config.tracker?.followUpDays ?? 3;

  function daysInGroup(m) {
    const joined = parseDate(m.joinDate);
    if (!joined) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    joined.setHours(0, 0, 0, 0);
    return Math.round((today - joined) / 86400000);
  }

  // '' = called but nothing recorded yet (no answer, undecided). Anything the operator
  // types must map to a known outcome or be rejected — silently recording "maybe" as
  // interested would poison the log.
  // Matches from the FRONT and hands back whatever follows as `rest` — that tail is the
  // name when the person isn't in the sheet yet (`called 98551XXXXX interested Rahul`).
  function parseOutcome(words) {
    const w = words.map(s => s.toLowerCase());
    if (w.length === 0) return { ok: true, value: null, rest: [] };  // null = leave as-is
    if (w[0] === 'not' && w[1] === 'interested') {
      return { ok: true, value: 'not-interested', rest: words.slice(2) };
    }
    if (['interested', 'yes', 'y', 'int'].includes(w[0])) {
      return { ok: true, value: 'interested', rest: words.slice(1) };
    }
    if (['notinterested', 'not-interested', 'not', 'no', 'n'].includes(w[0])) {
      return { ok: true, value: 'not-interested', rest: words.slice(1) };
    }
    return { ok: false, value: null, rest: [] };
  }

  // `pending` — who to call. Two blocks: people whose month is up and have never been
  // called, then people who were called but whose answer was never recorded.
  async function handlePending() {
    await store.refresh();
    // Removed people are never called again — they aren't in the groups any more.
    const all = store.getAll().filter(m => m.status !== 'REMOVED');

    const due = all.filter(m => isCallDue(m, callAfterDays))
      .sort((a, b) => (daysInGroup(b) ?? 0) - (daysInGroup(a) ?? 0));
    const followUp = all.filter(m => needsFollowUp(m, followUpDays))
      .sort((a, b) => (daysFromToday(a.callDate) ?? 0) - (daysFromToday(b.callDate) ?? 0));

    if (due.length === 0 && followUp.length === 0) {
      const soonest = all
        .filter(m => UNCALLED_STATUSES.includes(m.status) && daysInGroup(m) !== null)
        .sort((a, b) => (daysInGroup(b) ?? 0) - (daysInGroup(a) ?? 0))[0];
      const hint = soonest
        ? `\nNext up: ${soonest.name} in ${callAfterDays - daysInGroup(soonest)} day(s).`
        : '';
      return `✅ Nobody to call right now.${hint}`;
    }

    let msg = `📞 CALL LIST — ${due.length + followUp.length} person(s)\n━━━━━━━━━━━━━━━━━━━\n`;

    if (due.length > 0) {
      msg += `\n🆕 MONTH UP — pitch the app (${due.length})\n`;
      msg += due.map((m, i) => `${i + 1}. ${m.name}  ${m.phone}  (${daysInGroup(m)}d in group)`).join('\n') + '\n';
    }

    if (followUp.length > 0) {
      msg += `\n🔁 CALLED, no answer recorded — try again (${followUp.length})\n`;
      msg += followUp.map((m, i) => {
        const ago = m.callDate ? `${Math.abs(daysFromToday(m.callDate))}d ago` : 'date unknown';
        return `${i + 1}. ${m.name}  ${m.phone}  (called ${ago})`;
      }).join('\n') + '\n';
    }

    const example = due[0]?.phone || followUp[0]?.phone;
    msg += `\nAfter the call, log what they said:`;
    msg += `\n  called ${example} interested`;
    msg += `\n  called ${example} not interested`;
    msg += `\n  called ${example}            (no answer — reappears in ${followUpDays} day(s))`;
    msg += `\n\nCalled someone who isn't in the sheet? Add their name and they get a row:`;
    msg += `\n  called 98551XXXXX interested Rahul Kumar`;
    return msg;
  }

  // `called [phone] [interested|not interested]` — records that the pitch happened, the
  // date, and the answer. Nothing else changes: they stay in the group either way.
  async function handleCalled(args) {
    if (args.length < 1) {
      return '❌ Format: called [phone] [interested | not interested]\n' +
        'Not in the sheet yet? Add the name: called [phone] interested [Name]';
    }
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: called 98551XXXXX';

    const outcome = parseOutcome(args.slice(1));
    if (!outcome.ok) {
      return `❌ Unknown outcome "${args.slice(1).join(' ')}".\n` +
        `Use: called ${phone} interested   —or—   called ${phone} not interested\n` +
        `Or just: called ${phone}   (call happened, no answer yet)\n` +
        `Name goes LAST, after the outcome: called ${phone} interested Rahul`;
    }

    const callDate = todayStr();

    // Not in the sheet — the operator called someone who was never logged as a join.
    // Refusing would lose the answer, so take the name on the spot and create the row.
    let member = store.findByPhone(phone);
    let created = false;
    if (!member) {
      const name = outcome.rest.join(' ').trim();
      if (name.length < 2) {
        const tail = outcome.value === 'not-interested' ? 'not interested' : outcome.value || '';
        return `❓ ${phone} isn't in the sheet. What's their name?\n` +
          `Send:  called ${phone} ${tail}${tail ? ' ' : ''}[Name]`;
      }
      member = await store.add({
        name,
        phone,
        joinDate: callDate,
        billingDate: '',
        // 0 = not counted as a new member or join revenue anywhere (same flag addsilent uses).
        paidLast: 0,
        status: 'CALLED',
        callDate,
        callResult: outcome.value || '',
      }) || { name, phone };
      created = true;
      log.info(`➕ ${name} (${phone}) added to sheet from a call log`);
    }

    const repeat = !created && member.status === 'CALLED';
    if (!created) {
      const updates = { status: 'CALLED', callDate };
      if (outcome.value) updates.callResult = outcome.value;
      await store.update(phone, updates);
    }

    const said = outcome.value === 'interested' ? ' — INTERESTED'
      : outcome.value === 'not-interested' ? ' — NOT interested' : '';
    log.info(`📞 Called ${member.name} (${phone})${repeat ? ' [repeat]' : ''}${said}`);

    const head = `📞 ${member.name} (${phone}) — called ${callDate}${repeat ? ' (again)' : ''}` +
      (created ? `\n➕ Not in the sheet before — added as a new row.` : '');
    if (outcome.value === 'interested') {
      return `${head}\n✅ Logged as INTERESTED.\n` +
        `They stay in the group — move them onto the app yourself, then "kick ${phone}" when you want the seat back.`;
    }
    if (outcome.value === 'not-interested') {
      return `${head}\n❌ Logged as NOT interested.\n` +
        `Dropped from "pending". Still in the group — "kick ${phone}" if you want the seat back.\n` +
        `Changed their mind? called ${phone} interested`;
    }
    return `${head}\n📝 No answer recorded.\n` +
      `Reappears in "pending" after ${followUpDays} day(s).\n` +
      `Log it later: called ${phone} interested  /  called ${phone} not interested`;
  }

  // `log` (also `calls`) — the whole record, by bucket. Returns an array: the interested
  // and not-interested lists get long, and one WhatsApp message caps near 4096 chars.
  async function handleLog() {
    await store.refresh();
    // Anyone removed from the groups is out of the record entirely. The uncalled buckets
    // filter on status so they were already safe, but the interested / not-interested
    // buckets key off callResult alone — without this, someone called months ago and
    // since kicked would sit in the log forever as a live prospect.
    const all = store.getAll().filter(m => m.status !== 'REMOVED');

    const interested = all.filter(m => m.callResult === 'interested');
    const notInterested = all.filter(m => m.callResult === 'not-interested');
    const noAnswer = all.filter(m => m.status === 'CALLED' && !m.callResult);
    const notCalled = all.filter(m => UNCALLED_STATUSES.includes(m.status));
    const dueNow = notCalled.filter(m => isCallDue(m, callAfterDays));

    const called = interested.length + notInterested.length + noAnswer.length;
    const answered = interested.length + notInterested.length;
    const rate = answered > 0 ? Math.round((interested.length / answered) * 100) : 0;

    const lines = [
      `📋 CALL LOG — ${config.botName}`,
      `━━━━━━━━━━━━━━━━━━━`,
      `Called: ${called}   ·   Not called yet: ${notCalled.length}   ·   In groups: ${all.length}`,
      answered > 0 ? `Of ${answered} who answered, ${interested.length} were interested (${rate}%)` : '',
    ].filter(Boolean);

    const block = (title, list, note) => {
      if (list.length === 0) return [];
      const out = [`\n${title} (${list.length})`];
      out.push(...list
        .sort((a, b) => (daysFromToday(a.callDate) ?? 0) - (daysFromToday(b.callDate) ?? 0))
        .map(m => `• ${m.name}  ${m.phone}${note ? note(m) : ''}`));
      return out;
    };

    lines.push(...block('✅ INTERESTED', interested, m => m.callDate ? `  — called ${m.callDate}` : ''));
    lines.push(...block('❌ NOT INTERESTED', notInterested, m => m.callDate ? `  — called ${m.callDate}` : ''));
    lines.push(...block('📞 CALLED, no answer recorded', noAnswer, m => m.callDate ? `  — called ${m.callDate}` : ''));

    if (notCalled.length > 0) {
      lines.push(`\n⏳ NOT CALLED YET (${notCalled.length}) — ${dueNow.length} due now`);
      lines.push(...notCalled
        .sort((a, b) => (daysInGroup(b) ?? 0) - (daysInGroup(a) ?? 0))
        .map(m => {
          const d = daysInGroup(m);
          const flag = isCallDue(m, callAfterDays) ? '  ← call now' : '';
          return `• ${m.name}  ${m.phone}  (${d === null ? '?' : d}d in group)${flag}`;
        }));
    }

    lines.push(`\nWho to call today: pending`);

    return chunkByChars(lines).map((chunk, i, arr) =>
      (arr.length > 1 && i > 0 ? `📋 (${i + 1}/${arr.length})\n` : '') + chunk.join('\n')
    );
  }

  return { handlePending, handleCalled, handleLog };
}
