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

export function createDeliveryTracker(log, { max = 1000 } = {}) {
  // messageId → highest status seen. Insertion-ordered and trimmed from the front: a bot that
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
        // Highest wins. Receipts can arrive out of order, and a READ must never be walked
        // back to SERVER_ACK by a late duplicate.
        seen.set(id, Math.max(seen.get(id) ?? 0, status));
        if (seen.size > max) seen.delete(seen.keys().next().value);
      }
    });
  }

  // PENDING, not undefined, for an id nothing has come back about — that is precisely what
  // "handed over, nothing heard" means.
  const statusOf = (id) => (id && seen.has(id) ? seen.get(id) : STATUS.PENDING);

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
    const status = statusOf(id);
    if (status >= STATUS.DELIVERY_ACK) return { ok: true, status };
    const hard = status < STATUS.SERVER_ACK;
    return { ok: false, hard, status, why: STATUS_LABEL[status] || `status ${status}` };
  }

  return { attach, statusOf, verdict, size: () => seen.size };
}
