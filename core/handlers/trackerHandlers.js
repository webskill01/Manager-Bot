import {
  normalizePhone, formatDate, todayStr, parseDate, daysFromToday,
  isCallDue, needsFollowUp,
} from '../globalConfig.js';

// Tracker profile only. The operator gathers new joins, calls each person once they've
// been in the group a month to move them onto the app, then removes them from the group.
// Lifecycle: NEW → CALLED → MOVED. DUE_CALL is derived, never stored.
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

  // `pending` — the call list. Two blocks: people whose month is up and haven't been
  // called, then people who were called but never actually moved onto the app.
  async function handlePending() {
    await store.refresh();
    const all = store.getAll();

    const due = all.filter(m => isCallDue(m, callAfterDays))
      .sort((a, b) => (daysInGroup(b) ?? 0) - (daysInGroup(a) ?? 0));
    const followUp = all.filter(m => needsFollowUp(m, followUpDays))
      .sort((a, b) => (daysFromToday(a.callDate) ?? 0) - (daysFromToday(b.callDate) ?? 0));

    if (due.length === 0 && followUp.length === 0) {
      const soonest = all
        .filter(m => m.status === 'NEW' && daysInGroup(m) !== null)
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
      msg += `\n🔁 CALLED BUT NOT MOVED — chase again (${followUp.length})\n`;
      msg += followUp.map((m, i) => {
        const ago = m.callDate ? `${Math.abs(daysFromToday(m.callDate))}d ago` : 'date unknown';
        return `${i + 1}. ${m.name}  ${m.phone}  (called ${ago})`;
      }).join('\n') + '\n';
    }

    msg += `\nAfter calling:  called ${due[0]?.phone || followUp[0]?.phone}`;
    msg += `\nOnce on the app: moved ${due[0]?.phone || followUp[0]?.phone}  (also removes from groups)`;
    return msg;
  }

  // `called [phone]` — records the pitch. Member stays in the group: they haven't
  // installed anything yet, and removing them now would lose them.
  async function handleCalled(args) {
    if (args.length < 1) return '❌ Format: called [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: called 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status === 'MOVED') return `ℹ️ ${member.name} is already MOVED to the app.`;

    const callDate = todayStr();
    const repeat = member.status === 'CALLED';
    await store.update(phone, { status: 'CALLED', callDate });

    log.info(`📞 Called ${member.name} (${phone})${repeat ? ' [repeat]' : ''}`);
    return `📞 ${member.name} (${phone}) marked CALLED on ${callDate}.${repeat ? ' (called again)' : ''}\n` +
      `Still in the group — send "moved ${phone}" once they're on the app.\n` +
      `Reappears in "pending" after ${followUpDays} day(s) if not moved.`;
  }

  // `moved [phone]` — they're on the app. Mark MOVED and remove from every group.
  // Sheet is written only after the group removal reports back, so a failed removal
  // never leaves someone marked MOVED while still sitting in the group.
  async function handleMoved(args) {
    if (args.length < 1) return '❌ Format: moved [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: moved 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status === 'MOVED') return `ℹ️ ${member.name} is already MOVED.`;

    const result = await groupManager.removeFromAllGroups(phone);
    if (result.blocked) return result.blocked;
    const { removed, failed } = result;

    await store.update(phone, { status: 'MOVED', callDate: member.callDate || todayStr() });

    log.info(`✅ Moved ${member.name} (${phone}) to the app — removed from ${removed.length} group(s)`);
    let reply = `✅ ${member.name} (${phone}) marked MOVED — on the app now.\n` +
      `🚫 Removed from ${removed.length}/${config.paidGroups.length} group(s).`;
    if (failed.length > 0) reply += `\n⚠️ ${failed.length} group(s) failed — re-run: kick ${phone}`;
    return reply;
  }

  // `calls` — the funnel. Where people are, and where they're getting stuck.
  async function handleCalls() {
    await store.refresh();
    const all = store.getAll();
    const count = s => all.filter(m => m.status === s).length;

    const newTotal = count('NEW');
    const called = count('CALLED');
    const moved = count('MOVED');
    const removed = count('REMOVED');
    const dueNow = all.filter(m => isCallDue(m, callAfterDays)).length;
    const followUp = all.filter(m => needsFollowUp(m, followUpDays)).length;

    // This month's movement, by the date each transition was stamped.
    const now = new Date();
    const thisMonth = d => {
      const parsed = parseDate(d);
      return parsed && parsed.getMonth() === now.getMonth() && parsed.getFullYear() === now.getFullYear();
    };
    const joinedThisMonth = all.filter(m => thisMonth(m.joinDate)).length;
    const calledThisMonth = all.filter(m => thisMonth(m.callDate)).length;

    const reached = called + moved;
    const conversion = reached > 0 ? Math.round((moved / reached) * 100) : 0;

    return `📊 CALL FUNNEL — ${config.botName}\n━━━━━━━━━━━━━━━━━━━\n\n` +
      `🆕 NEW (in group, not called):  ${newTotal}\n` +
      `   ↳ month up, call now:       ${dueNow}\n` +
      `📞 CALLED (pitched, not moved): ${called}\n` +
      `   ↳ needs a chase:            ${followUp}\n` +
      `✅ MOVED (on the app):          ${moved}\n` +
      `🚫 REMOVED (dropped):           ${removed}\n\n` +
      `📈 Conversion: ${moved}/${reached} pitched → app (${conversion}%)\n\n` +
      `📅 This month: ${joinedThisMonth} joined · ${calledThisMonth} called`;
  }

  return { handlePending, handleCalled, handleMoved, handleCalls };
}
