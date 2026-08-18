import { normalizePhone } from './globalConfig.js';

// Stand-in for groupManager.js on bots whose operator runs over Telegram.
//
// Those bots hold no WhatsApp connection at all — that is the entire point of the switch —
// so nothing here can touch a group. Members stay in their existing WhatsApp groups and the
// operator does the group half by hand. What this module does is make the hand-off cheap:
// every method that used to perform a group action instead returns the instruction for it,
// with the message text pre-built and one-tap sendable.
//
// The interface is identical to createGroupManager's, so no handler needs to know which one
// it was given. Two conventions carry the difference:
//   • `manual: true` on the manager     — handlers branch on it only where wording differs
//   • `manual: "<text>"` on a result    — the operator instruction, rendered as-is
//
// Anything requiring LIVE group state (who is in a group, who is waiting to join) is
// genuinely impossible without a socket and throws NoGroupAccessError. commandParser
// refuses those commands up front, so a throw here means a code path got missed — loud
// is correct.

export class NoGroupAccessError extends Error {
  constructor(what) {
    super(`${what} needs a live WhatsApp connection — this bot runs on Telegram and has none.`);
    this.name = 'NoGroupAccessError';
  }
}

// parseGroupLink is gone. config.groupLinks used to store a label and a URL in one blob and
// this split them apart; config now carries config.groupNames (labels only). Invite URLs are
// fetched live from the socket where one exists, and simply do not exist where one does not
// — a stored invite link is wrong the moment the number is banned and re-linked.

// wa.me opens WhatsApp with a chat to `phone` and `text` already typed, so the operator
// sends from their own phone with one tap. Same technique dmList.js uses for reminders —
// the message travels as a normal human message, which is precisely why no number gets
// flagged for it.
export function waMeLink(phone, text) {
  const digits = String(phone).replace(/\D/g, '');
  const intl = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

export function createManualGroupManager(config, log) {
  const paidGroups = config.paidGroups || [];
  const names = config.groupNames || [];

  // Group names for "remove them from…" instructions. config.groupNames carries the real
  // subjects, so prefer them — but ONLY when they cover every paid group. If the two lists have drifted,
  // naming the shorter one would tell the operator to clear 2 groups when the bot manages 3
  // and quietly leave someone inside a paid group. A vaguer, complete list beats a precise,
  // incomplete one.
  function groupNames() {
    if (names.length === paidGroups.length && names.length > 0) return names;
    return paidGroups.map((id, i) => `Group ${i + 1} (${String(id).slice(0, 12)}…)`);
  }

  // Bullets, not numbers — the configured names usually start with "1." already.
  function bulleted(names) {
    return names.map(n => `   • ${n}`).join('\n');
  }

  // handleAdd / handleSendLinks build the onboarding sequence (group links + welcome) and
  // hand it here to be delivered. Deliver it as one tap-to-send link instead: the parts are
  // joined with blank lines so the member receives a single readable message.
  async function sendToMember(phone, messages) {
    const text = (messages || []).join('\n\n');
    const link = waMeLink(phone, text);
    log.info(`📎 Manual send prepared for ${normalizePhone(phone)} (${text.length} chars)`);
    return {
      sent: 0,
      failed: 0,
      manual:
        `📲 Tap to send them the links + welcome message:\n${link}\n\n` +
        `(opens WhatsApp with the message already typed — just hit send)`,
    };
  }

  async function _removeFromAllGroups(phone) {
    const names = groupNames();
    return {
      removed: [],
      failed: [],
      manual:
        `👆 Now remove ${normalizePhone(phone)} from these ${names.length} group(s) in WhatsApp:\n` +
        bulleted(names),
    };
  }

  function removeFromAllGroups(phone) { return _removeFromAllGroups(phone); }

  async function _addToAllGroups(phone, name) {
    const names = groupNames();
    return {
      added: [],
      failed: [],
      manual:
        `👆 Now add ${name || ''} ${normalizePhone(phone)} to these ${names.length} group(s) in WhatsApp:\n` +
        bulleted(names),
    };
  }

  function addToAllGroups(phone, name) { return _addToAllGroups(phone, name); }
  function rejoinAdd(phone, name) { return _addToAllGroups(phone, name); }

  // No socket means groupInviteCode() cannot be called, and invite URLs are no longer kept
  // in config — they reset on every ban and re-link, so a stored copy is wrong more often
  // than right. These bots run 2-3 groups whose operators share invites from their own
  // phones. Returning [] makes handleAdd/handleSendLinks say exactly that.
  async function getInviteLinksForMissing() {
    return [];
  }

  async function checkMembership() { throw new NoGroupAccessError('groupcheck'); }
  async function getAllPendingRequests() { throw new NoGroupAccessError('reading join requests'); }
  async function approveAllPendingRequests() { throw new NoGroupAccessError('approve'); }
  async function rejectAllPendingRequests() { throw new NoGroupAccessError('reject'); }
  async function approveByPhone() { throw new NoGroupAccessError('approve'); }
  async function rejectByPhone() { throw new NoGroupAccessError('reject'); }

  // No socket to abort. Kept so the interface matches and callers stay transport-blind.
  function markAborted() {}

  return {
    manual: true,
    addToAllGroups, rejoinAdd, removeFromAllGroups, getInviteLinksForMissing,
    checkMembership, getAllPendingRequests, approveAllPendingRequests,
    rejectAllPendingRequests, approveByPhone, rejectByPhone, markAborted, sendToMember,
  };
}
