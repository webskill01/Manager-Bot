import { isSlowCommand } from './commandParser.js';

// The Telegram Bot API half of a bot, with nothing above it: no sheet, no store, no
// command parser. Give it a token, the operator allow-list, and a function to call when
// an authorized operator sends a command, and it moves bytes.
//
// Two callers, deliberately:
//   • core/telegram.js — a bot whose ONLY transport is Telegram (the four tracker bots).
//     It holds no WhatsApp socket at all and every group command is refused.
//   • core/index.js    — bot-nitin's "dual" transport, where this listener runs ALONGSIDE
//     a live Baileys socket and hands commands to the SAME parser. That is what makes
//     `kick 9855112233` typed in Telegram genuinely remove the member from all 12 groups,
//     and what keeps the sheet reachable after a 403 kills the socket.
//
// This file was extracted verbatim from core/telegram.js — the polling loop, the chunked
// send, the bootstrap-mode enrolment and the ack are the originals, not reimplementations.

const API = 'https://api.telegram.org/bot';

// Telegram's own cap is 4096; chunkByChars already splits handler output at 3000
// (globalConfig.MAX_CHARS_PER_MSG), so this only catches a handler that ignored it.
const TG_MAX = 4000;

// onCommand(text, reply) — `reply` sends back to the chat the command came from, chunked.
// Return value is ignored: replying is the callback's job, so a caller can send progress
// mid-command rather than only at the end.
export function createTelegramListener({ token, allowedIds = [], bootstrapMode = false, botName, log, onCommand, fetchImpl = globalThis.fetch }) {
  const allowed = new Set(allowedIds);
  let offset = 0;
  let stopped = false;
  let me = null;

  async function api(method, body) {
    const res = await fetchImpl(`${API}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) {
      // Telegram puts the status in error_code and a sentence in description ("Unauthorized",
      // "Conflict: terminated by other getUpdates request"). Carry the code on the error —
      // the description alone never contains the number, so callers can't match on text.
      const err = new Error(`${method}: ${data.description || res.status}`);
      err.code = data.error_code || res.status;
      throw err;
    }
    return data.result;
  }

  // No parse_mode, on purpose. Handler output uses WhatsApp's *bold* convention, and in
  // Telegram's Markdown a stray * or _ inside a member's name makes the API reject the
  // WHOLE message — the operator would see nothing at all. Plain text renders the
  // asterisks literally and can never drop a reply.
  async function send(chatId, text) {
    const str = String(text ?? '');
    if (!str) return;
    for (let i = 0; i < str.length; i += TG_MAX) {
      await api('sendMessage', {
        chat_id: chatId,
        text: str.slice(i, i + TG_MAX),
        disable_web_page_preview: true,
      });
    }
  }

  async function broadcast(text) {
    for (const id of allowed) {
      try { await send(id, text); }
      catch (err) { log.warn(`⚠️  Broadcast to ${id} failed: ${err.message}`); }
    }
  }

  // Telegram's UI pushes slash-commands hard: it sends `/start` by itself when someone
  // opens the bot, autocompletes `/…`, and appends `@botname` in groups. None of that is a
  // WhatsApp convention, so the shared parser knows nothing about it and every slashed
  // command fell through to "❓ Unknown command". Normalising here — at the transport that
  // invents the syntax — keeps the parser transport-blind. `/summary` becomes `summary`.
  function stripSlash(text) {
    const m = text.match(/^\/([A-Za-z][\w]*)(?:@\S+)?(\s[\s\S]*)?$/);
    if (!m) return text;
    // `/start` is Telegram's "open the bot" handshake, not a command anyone typed on
    // purpose. Show the help everyone actually wants at that moment.
    if (m[1].toLowerCase() === 'start' && !m[2]) return 'help';
    return `${m[1]}${m[2] || ''}`;
  }

  async function handleMessage(msg) {
    const from = msg.from?.id;
    const chatId = msg.chat?.id;
    const text = stripSlash((msg.text || '').trim());
    if (!from || !chatId || !text) return;

    // Bootstrap: allowedTelegramIds is empty, so nobody is an operator yet and there is
    // nothing to protect. Hand each person their own id so they can be enrolled, and run
    // no commands at all. Filling the list in config.json ends this mode on next restart.
    if (bootstrapMode) {
      log.warn(`🔑 SETUP — id=${from} name=${msg.from?.first_name || '?'} (add to allowedTelegramIds in bots/${botName}/config.json)`);
      await send(chatId,
        `🔑 Setup mode — this bot has no operators yet.\n\n` +
        `Your Telegram ID:\n${from}\n\n` +
        `Put it in bots/${botName}/config.json:\n` +
        `  "allowedTelegramIds": [${from}]\n\n` +
        `Add every operator's ID to that list, then restart the bot:\n` +
        `  pm2 restart ${botName}\n\n` +
        `No commands will run until then.`);
      return;
    }

    // Configured, and this isn't one of them → answer nothing. Replying would confirm the
    // bot exists to anyone who stumbled onto its username. The id goes to the log so an
    // operator can enrol a new colleague without reopening setup mode.
    if (!allowed.has(from)) {
      log.warn(`🔑 Unauthorized Telegram sender: id=${from} name=${msg.from?.first_name || '?'} — add to allowedTelegramIds to grant access`);
      return;
    }

    log.info(`📥 Telegram command from ${from}: "${text.substring(0, 80)}"`);

    // Instant receipt for commands that do sheet writes or network calls before replying,
    // so the operator can tell it landed. Quick lookups answer immediately and skip this.
    if (isSlowCommand(text)) {
      const label = text.split(/\s+/).slice(0, 2).join(' ');
      try { await send(chatId, `⏳ Got it — working on "${label}"…`); }
      catch (err) { log.warn(`⚠️  Ack send failed: ${err.message}`); }
    }

    // Handlers may return an array when output exceeds one message (dmlist, log). Send the
    // parts in order with a small gap so they arrive in sequence rather than racing.
    const reply = async (out) => {
      if (!out) return;
      const parts = Array.isArray(out) ? out : [out];
      for (const [i, part] of parts.entries()) {
        if (i > 0) await new Promise(res => setTimeout(res, 800));
        await send(chatId, part);
      }
      log.info(`📤 Telegram reply to ${chatId} (${parts.length} msg, ${parts.join('').length} chars)`);
    };

    await onCommand(text, reply);
  }

  // Long polling, not a webhook: no public URL, no TLS certificate, no inbound firewall
  // rule. Telegram holds the request open for up to 50s and returns as soon as anything
  // arrives, so this is idle almost all the time.
  //
  // Resolves when stop() is called; rejects only on a revoked token. Callers decide what
  // that means: telegram.js dies (Telegram is its only transport), index.js logs and keeps
  // the WhatsApp socket serving.
  async function poll() {
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          // Advance the offset BEFORE handling. Telegram redelivers everything at or above
          // `offset` until it moves, so a command that throws mid-way — half a sheet write
          // already done — must not be replayed on the next poll. This is also what makes
          // the WhatsApp path's seenMessageIds dedup map unnecessary here.
          offset = u.update_id + 1;
          if (!u.message) continue;
          try { await handleMessage(u.message); }
          catch (err) { log.error(`❌ Telegram message error: ${err.message}`); }
        }
      } catch (err) {
        if (stopped) return;
        // 409 means another process is polling the same token — usually a stale pm2 copy.
        // Say so plainly; the generic retry below would otherwise hide it forever.
        if (err.code === 409) {
          log.error(`❌ ${err.message}\n   Another process is polling this bot token. Check: pm2 list`);
        } else if (err.code === 401) {
          // The token was revoked or regenerated in @BotFather mid-run. Retrying forever is
          // pointless and buries the reason.
          log.error(`❌ ${err.message}\n   Token no longer valid — re-issue it with /token in @BotFather and update the bot's .env.`);
          throw err;
        } else {
          log.warn(`⚠️  Telegram poll failed: ${err.message}`);
        }
        await new Promise(res => setTimeout(res, 5000));
      }
    }
  }

  // getMe both validates the token and gives the operator the @username to open. Separate
  // from start() so a caller can fail fast on a bad token before doing anything else.
  async function connect() {
    try {
      me = await api('getMe');
    } catch (err) {
      log.error(`❌ Telegram token rejected — ${err.message}`);
      log.error('   Check TELEGRAM_TOKEN in the bot\'s .env, or re-issue it with /token in @BotFather.');
      throw err;
    }
    if (bootstrapMode) {
      log.warn('🔑 SETUP MODE — no operators configured yet. The bot will reply to anyone');
      log.warn(`   with their Telegram ID and run NO commands. Open https://t.me/${me.username},`);
      log.warn(`   send it anything, then put the IDs in bots/${botName}/config.json.`);
    }
    return me;
  }

  return {
    connect,
    start: poll,
    stop: () => { stopped = true; },
    broadcast,
    send,
    getMe: () => me,
    operatorCount: () => allowed.size,
    operatorIds: () => [...allowed],
  };
}
