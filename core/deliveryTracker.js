// Did the message actually arrive?
//
// sock.sendMessage() resolves when the message node has been handed to WhatsApp — NOT when
// the server accepted it, and certainly not when it reached the recipient's phone. Its type
// is even `Promise<WAMessage | undefined>`, so it can resolve with nothing at all. "No
// exception" has never meant "delivered", and every send path here treated them as the same
// thing: on 25-08-2026 that produced nine `💧 Auto-sent` log lines and five real messages,
// with nothing anywhere recording the difference.
//
// WhatsApp reports the truth afterwards on `messages.update`, whose payload is
// `{ key, update: Partial<WAMessage> }` — so the status arrives as `update.status`.
//
// Verified against @whiskeysockets/baileys 7.0.0-rc13, Utils/generics.js:
//
//   const STATUS_MAP = { sender: SERVER_ACK, played: PLAYED, read: READ, 'read-self': READ }
//   getStatusFromReceiptType = type => type === undefined ? DELIVERY_ACK : STATUS_MAP[type]
//
// Two consequences that shape everything below:
//
//   1. An ordinary delivery receipt carries NO type attribute, so it maps to DELIVERY_ACK.
//      That is the "two ticks" signal and the only proof the message reached a device.
//   2. An unrecognised receipt type yields `undefined`, and Baileys still emits the update
//      with `status: undefined` — so a numeric check on the way in is required, not tidiness.
export const STATUS = {
  ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5,
};

export const STATUS_LABEL = {
  0: 'the server rejected it',
  1: 'never acknowledged — it did not leave the bot',
  2: 'WhatsApp accepted it but it has not reached their phone',
  3: 'delivered',
  4: 'read',
  5: 'played',
};

// Why the server rejected a message, when it says. Verified against baileys 7.0.0-rc13
// Utils/decode-wa-message.js, where the codes and this explanation both live:
//
//   463 SenderReachoutTimelocked / MessageAccountRestriction
//       "1:1 message missing privacy token (tctoken). Usually means the account is
//        restricted: WhatsApp blocks starting new chats but preserves existing ones,
//        since established chats already carry a tctoken."
//
//       This is the shape of a partial restriction, and it explains a split delivery
//       exactly: members the operator has messaged before still get through, members they
//       have never messaged do not. No amount of retrying changes it, and retrying is
//       precisely how a restriction becomes a ban.
//
//   479 SmaxInvalid — "stanza rejected by server, likely stale device session or malformed
//       addressing". A reconnect genuinely can fix this one.
export const REJECTION = {
  '463': {
    fatal: true,
    what: 'your account is RESTRICTED from starting new chats',
    detail: 'WhatsApp is blocking messages to people this number has never messaged before. ' +
            'Existing conversations still work, which is why some reminders land and some do not. ' +
            'Retrying will not help and makes a ban more likely.',
  },
  '479': {
    fatal: false,
    what: 'the stanza was rejected — stale device session',
    detail: 'Usually clears on a reconnect. If it persists for one member, their session is stale.',
  },
};

export function createDeliveryTracker(log, { max = 1000 } = {}) {
  // messageId → { status, code }. Insertion-ordered and trimmed from the front: a bot that
  // runs for months must not keep one entry per message it has ever sent.
  const seen = new Map();

  // Baileys hands out a NEW socket on every reconnect and listeners live on the socket, not
  // on the connection — so re-attaching per socket is required, not optional. A tracker
  // attached once at boot goes deaf after the first reconnect, which on this bot is roughly
  // hourly.
  function attach(sock) {
    if (!sock?.ev?.on) return;
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates || []) {
        const id = u?.key?.id;
        const status = u?.update?.status;
        // See note 2 above: `status: undefined` is a normal payload here, not a malformed one.
        if (!id || typeof status !== 'number') continue;
        // The reason rides along on an ERROR ack as messageStubParameters[0]. It is the
        // difference between "reconnect" and "stop sending immediately", so it must not be
        // thrown away with the rest of the payload.
        const code = String(u?.update?.messageStubParameters?.[0] ?? '') || null;
        const prev = seen.get(id);
        // Highest status wins — receipts arrive out of order and a READ must never be walked
        // back by a late duplicate — but a reason, once given, is kept.
        seen.set(id, {
          status: Math.max(prev?.status ?? 0, status),
          code: code || prev?.code || null,
        });
        if (seen.size > max) seen.delete(seen.keys().next().value);
      }
    });
  }

  // PENDING, not undefined, for an id nothing has come back about — that is precisely what
  // "handed over, nothing heard" means.
  const entryOf = (id) => (id && seen.has(id) ? seen.get(id) : { status: STATUS.PENDING, code: null });
  const statusOf = (id) => entryOf(id).status;

  // Two tiers, because they are two different problems with two different responses.
  //
  //   hard  — never reached SERVER_ACK. The message did not leave. Nothing about the
  //           recipient can cause this, so it is always worth interrupting the operator.
  //
  //   soft  — SERVER_ACK but no DELIVERY_ACK. WhatsApp took it and no device has confirmed
  //           it. A recipient with their phone off looks EXACTLY like this and will clear on
  //           its own when they come online, so one of these means nothing. Twelve out of
  //           eighteen means the number is being filtered — which is a pattern, visible in a
  //           count at the end of the day, and not something to buzz about per message.
  //
  // Reporting soft failures as alarms would train the operator to ignore the alarm, which
  // costs more than the missing information.
  function verdict(id) {
    const { status, code } = entryOf(id);
    if (status >= STATUS.DELIVERY_ACK) return { ok: true, status, code: null };
    const hard = status < STATUS.SERVER_ACK;
    const reason = code ? REJECTION[code] : null;
    return {
      ok: false, hard, status, code,
      // `fatal` means "no future send will work either" — the caller is expected to stop the
      // day rather than walk the whole queue into the same wall.
      fatal: !!reason?.fatal,
      why: reason ? `${reason.what} [${code}]` : (STATUS_LABEL[status] || `status ${status}`),
      detail: reason?.detail || null,
    };
  }

  return { attach, statusOf, verdict, size: () => seen.size };
}
