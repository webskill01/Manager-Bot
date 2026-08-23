import { isSlowCommand } from './commandParser.js';
import { HELP_CATEGORIES } from './helpText.js';

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
// 3500 rather than 4000 leaves room for the &amp;/&lt; escaping tapToCopy adds.
const TG_MAX = 3500;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Indian mobiles: 10 digits starting 6-9, with or without a 91 prefix. Fees (₹90), dates
// (23-08-2026) and day counts are all shorter, so nothing else in a reply matches.
const PHONE = /(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)/g;

// Tapping <code> text in Telegram copies it to the clipboard, which is the one thing the
// operator does with every number the bot prints: copy it, paste it into WhatsApp search
// to find the member. Applied here rather than in twenty handlers so every list, lookup,
// digest and kick instruction gets it on every bot.
//
// HTML, not Markdown — escaping is three characters and cannot fail, whereas a stray * or _
// in a member's name makes Telegram reject the WHOLE message and the operator sees nothing.
// Handler output keeps using WhatsApp's *bold*; HTML renders the asterisks literally, same
// as no parse_mode did.
//
// Tokens holding a URL or a JID are skipped whole: wrapping the 91… inside wa.me/91… would
// break the link the list exists to hand over.
export function tapToCopy(text) {
  return escapeHtml(text)
    .split(/(\s+)/)
    .map(tok => (tok.includes('http') || tok.includes('@') ? tok : tok.replace(PHONE, '<code>$1</code>')))
    .join('');
}

// ── The `/` menu and the button keyboard ─────────────────────────────────────
//
// Both are pure Telegram UI over the SAME text commands: setMyCommands fills the "/"
// autocomplete, and a reply keyboard renders the daily round as buttons whose press sends
// the plain word "dmlist". Nothing new reaches onCommand, so commandParser is untouched
// and can stay transport-blind. That is the whole reason it's these two and not inline
// callback buttons — those need a second update type and per-message pending state.
//
// Not the full ~50-command help, deliberately: a menu you scroll past is a menu you stop
// opening. `help` still prints everything.
const MENUS = {
  full: [
    ['dmlist', 'due today → 1st message, one tap-to-send link each'],
    ['dmlist2', 'the 5-day-overdue round → 2nd message'],
    ['dmlist3', 'the 6+ day round → final notice'],
    ['digest', "today's due / overdue / auto-renewed"],
    ['summary', "the day's money: joins, revenue, split"],
    ['due', 'who is due today'],
    ['overdue', 'everyone past their billing date'],
    ['upcoming', "who's due in the next 7 days"],
    ['find', '[phone or name] → full profile + ref count'],
    ['status', '[phone] → one-line status'],
    ['add', '[Name] [phone] → send links + record as NEW'],
    ['rejoin', '[phone] → reactivate an old member'],
    ['kick', '[phone] → remove from all groups'],
    ['renewed', '[phone] → log a renewal payment'],
    ['remind', '[phone] → send reminder + QR by hand'],
    ['delay', '[phone] [days] → hide from the removal list'],
    ['skip', '[phone] [reason] → park them'],
    ['links', 'the cached group invite links'],
    ['revenue', 'joining fees this month + split'],
    ['stats', 'the numbers'],
    ['ledger', 'the shared revenue sheet — it fills itself'],
    ['ping', 'is the bot alive'],
    ['help', 'every command'],
  ],
  tracker: [
    ['pending', 'who to call now + who gave no answer yet'],
    ['called', '[phone] [interested|not interested] → log a call'],
    ['log', 'the full call record'],
    ['digest', 'today at a glance'],
    ['summary', "the day's money: joins, revenue, split"],
    ['add', '[Name] [phone] → record + tap-to-send links'],
    ['addsilent', '[Name] [phone] → sheet only, no link'],
    ['sendlinks', '[phone] → the tap-to-send link again'],
    ['links', 'the group invite links, to paste anywhere'],
    ['rejoin', '[phone] → reactivate an old member'],
    ['kick', '[phone] → free the seat'],
    ['find', '[phone or name] → full profile'],
    ['status', '[phone] → one-line status'],
    ['removed', 'everyone kicked'],
    ['skipped', 'everyone parked'],
    ['revenue', 'joining fees this month + split'],
    ['stats', 'the numbers'],
    ['ledger', 'the shared revenue sheet — it fills itself'],
    ['ping', 'is the bot alive'],
    ['help', 'every command'],
  ],
};

// ── Follow-up buttons ────────────────────────────────────────────────────────
//
// A handful of replies are already menus written as prose — `stop` answers "Did you mean
// stop removal, stop kickall, or stop kickghosts?", `kickghosts` ends with "Send kickghosts
// confirm to start". These render that menu as inline buttons under the answer.
//
// callback_data is the LITERAL command string, which is the whole trick: the handler feeds
// it straight back into onCommand, so a button is indistinguishable from typing the words.
// No pending map, no message ids, nothing to expire — a button tapped a week from now does
// exactly what it says, or answers "unknown command" like any other stale text would.
//
// Rows of [callback_data, label]. Telegram caps callback_data at 64 bytes; the longest here
// is "stop kickghosts".
const FOLLOW_UPS = {
  drip:       [[['drip start', '▶️ start'], ['drip stop', '⏸ stop'], ['drip test', '🧪 test']]],
  kickghosts: [[['kickghosts confirm', '✅ confirm'], ['stop kickghosts', '✖️ stop']]],
  stop:       [[['stop removal', 'removal'], ['stop kickall', 'kickall'], ['stop kickghosts', 'kickghosts']]],
  summary:    [[['summary 1', 'yesterday'], ['summary 2', '2 days ago']]],
  due:        [[['due tomorrow', 'tomorrow']]],
  upcoming:   [[['upcoming 7', '7 days'], ['upcoming 14', '14 days'], ['upcoming 30', '30 days']]],
  links:      [[['refreshlinks', '🔄 refresh all links']]],
  ledger:     [[['ledger now', '📝 write today'], ['ledger sync', '🔄 backfill + fix']]],
};

// Which buttons belong under the answer to `text`, or null for the ~45 commands that have
// no fixed follow-up. Commands whose next step needs a phone or a name (cloudapi test,
// setlink, remind, the `moved`/`addnew` retirement hints) are deliberately absent — a
// button cannot supply an argument, so it would only ever produce a format error.
export function followUps(text, profile = 'full') {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // `delayall 7` prints a preview and the confirm must carry the SAME 7, so this one is
  // built from the command rather than looked up. Guarded on the days argument actually
  // being a number: `delayall abc` answers with a format error, and a confirm button under
  // a format error is a trap.
  if (cmd === 'delayall' && parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
    return [[[`delayall ${parts[1]} confirm`, `✅ confirm ${parts[1]}d`]]];
  }

  // `help` is an index of sections, and the sections ARE the buttons — so nobody has to know
  // the section names to reach them. Two per row: the labels carry an emoji and a word, and
  // three across wraps badly on a phone. Built from the same HELP_CATEGORIES the text uses,
  // so a button can never point at a section that does not exist.
  if (cmd === 'help' && parts.length === 1) {
    const cats = HELP_CATEGORIES[profile] || HELP_CATEGORIES.full;
    const rows = [];
    for (let i = 0; i < cats.length; i += 2) {
      rows.push(cats.slice(i, i + 2).map(([key, label]) => [`help ${key}`, label]));
    }
    rows.push([['help all', '📖 Everything']]);
    return rows;
  }

  // start / stop / test all leave the same three useful next steps, so the drip keeps its
  // buttons whichever one you pressed.
  if (cmd === 'drip') return FOLLOW_UPS.drip;

  // Everything else: bare command only. `summary 1` IS the follow-up, and `links 9855112233`
  // is a different question that has nothing to do with refreshing every group's invite.
  if (parts.length > 1) return null;
  return FOLLOW_UPS[cmd] || null;
}

const inlineKeyboard = (rows) =>
  rows.map(row => row.map(([callback_data, text]) => ({ text, callback_data })));

// Only commands that work with NO arguments. A button that sends a bare `find` would answer
// with a usage error, which is a worse button than no button.
const KEYBOARDS = {
  full: [['dmlist', 'dmlist2', 'dmlist3'], ['digest', 'summary', 'due'], ['overdue', 'links', 'help']],
  tracker: [['pending', 'log', 'digest'], ['summary', 'revenue', 'stats'], ['removed', 'links', 'help']],
};

// onCommand(text, reply) — `reply` sends back to the chat the command came from, chunked.
// Return value is ignored: replying is the callback's job, so a caller can send progress
// mid-command rather than only at the end.
export function createTelegramListener({ token, allowedIds = [], bootstrapMode = false, botName, profile = 'full', log, onCommand, fetchImpl = globalThis.fetch }) {
  const allowed = new Set(allowedIds);
  const menu = MENUS[profile] || MENUS.full;
  const keyboard = KEYBOARDS[profile] || KEYBOARDS.full;
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

  // Telegram allows ONE reply_markup per message, and the persistent keyboard and the inline
  // follow-up buttons are two mutually exclusive kinds of it. Follow-ups belong at the bottom
  // of the answer, so the LAST chunk carries them and the keyboard steps aside for that one
  // message — it persists from the previous message regardless, so nothing is lost.
  //
  // The keyboard is otherwise re-sent on the first chunk of every reply rather than once at
  // startup: Telegram keeps the last keyboard per chat, so an operator who hid it, or one
  // enrolled after boot, gets it back on their next command. Re-setting the same keyboard is
  // invisible to them. Withheld entirely in bootstrap mode — nobody there can run anything.
  function replyMarkup({ first, last, buttons }) {
    if (bootstrapMode) return {};
    if (last && buttons) return { reply_markup: { inline_keyboard: inlineKeyboard(buttons) } };
    if (first) return { reply_markup: { keyboard: keyboard.map(row => row.map(text => ({ text }))), resize_keyboard: true, is_persistent: true } };
    return {};
  }

  // Chunk the RAW text, then mark up each chunk — slicing marked-up text could cut a
  // <code> tag in half and Telegram would reject that chunk outright.
  async function send(chatId, text, { buttons = null } = {}) {
    const str = String(text ?? '');
    if (!str) return;
    const chunks = [];
    for (let i = 0; i < str.length; i += TG_MAX) chunks.push(str.slice(i, i + TG_MAX));
    for (const [i, chunk] of chunks.entries()) {
      await api('sendMessage', {
        chat_id: chatId,
        text: tapToCopy(chunk),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...replyMarkup({ first: i === 0, last: i === chunks.length - 1, buttons }),
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

    await run(text, chatId);
  }

  // Shared by a typed command and a tapped follow-up button — a button IS its command, so
  // there is no second code path for one.
  async function run(text, chatId) {
    // Handlers may return an array when output exceeds one message (dmlist, log). Send the
    // parts in order with a small gap so they arrive in sequence rather than racing.
    const reply = async (out) => {
      if (!out) return;
      const parts = Array.isArray(out) ? out : [out];
      // No follow-up buttons under a refusal. `drip` answers "⚠️ Drip unavailable" on a bot
      // with no Telegram listener, and offering start/stop/test under that is just three
      // more ways to read the same message.
      const buttons = /^\s*[❌⚠️]/.test(String(parts[0] || '')) ? null : followUps(text, profile);
      for (const [i, part] of parts.entries()) {
        if (i > 0) await new Promise(res => setTimeout(res, 800));
        await send(chatId, part, { buttons: i === parts.length - 1 ? buttons : null });
      }
      log.info(`📤 Telegram reply to ${chatId} (${parts.length} msg, ${parts.join('').length} chars)`);
    };

    await onCommand(text, reply);
  }

  // A tapped follow-up button. answerCallbackQuery FIRST and always: until it lands the
  // button spins on the operator's screen, and a slow command would leave it spinning for
  // minutes. Telegram redelivers a callback that is never answered.
  async function handleCallback(cb) {
    const from = cb.from?.id;
    const chatId = cb.message?.chat?.id;
    try { await api('answerCallbackQuery', { callback_query_id: cb.id }); }
    catch (err) { log.warn(`⚠️  answerCallbackQuery failed: ${err.message}`); }

    if (bootstrapMode || !from || !chatId || !allowed.has(from)) return;
    const text = String(cb.data || '').trim();
    if (!text) return;

    log.info(`📥 Telegram button from ${from}: "${text}"`);
    if (isSlowCommand(text)) {
      try { await send(chatId, `⏳ Got it — working on "${text}"…`); }
      catch (err) { log.warn(`⚠️  Ack send failed: ${err.message}`); }
    }
    await run(text, chatId);
  }

  // The two update kinds this bot asks for. Named and returned so a test can drive one
  // update through the real path without faking the polling loop around it.
  async function handleUpdate(u) {
    if (u.callback_query) return handleCallback(u.callback_query);
    if (u.message) return handleMessage(u.message);
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
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          // Advance the offset BEFORE handling. Telegram redelivers everything at or above
          // `offset` until it moves, so a command that throws mid-way — half a sheet write
          // already done — must not be replayed on the next poll. This is also what makes
          // the WhatsApp path's seenMessageIds dedup map unnecessary here.
          offset = u.update_id + 1;
          try { await handleUpdate(u); }
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
    // Fills Telegram's "/" autocomplete. Never fatal: a bot that can poll but can't set its
    // menu is a bot with no menu, not a bot that fails to start.
    try {
      await api('setMyCommands', { commands: menu.map(([command, description]) => ({ command, description })) });
    } catch (err) {
      log.warn(`⚠️  setMyCommands failed: ${err.message} — the / menu will be stale`);
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
    handleUpdate,
    start: poll,
    stop: () => { stopped = true; },
    broadcast,
    send,
    getMe: () => me,
    operatorCount: () => allowed.size,
    operatorIds: () => [...allowed],
  };
}
