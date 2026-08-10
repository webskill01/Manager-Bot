import express from 'express';

import { createSheetClient } from './sheetClient.js';
import { createMemberStore } from './memberStore.js';
import { createManualGroupManager } from './manualGroupManager.js';
import { createCommandParser, isSlowCommand } from './commandParser.js';

// Telegram transport — the operator-facing half of a tracker bot, replacing core/index.js.
//
// Why this exists: Baileys is an unofficial WhatsApp client, and running one is how a
// number gets flagged (bot-abhi already ate a 403). Tracker bots stopped sending anything
// on a schedule long ago — they read the sheet, write the sheet, and print reports when
// commanded. None of that needs WhatsApp. Moving the operator to Telegram's official Bot
// API removes the ban risk entirely, and the members never have to move: they stay in the
// same WhatsApp groups, and the operator does group work by hand (see manualGroupManager).
//
// Everything below the transport is shared verbatim with the WhatsApp path: sheetClient →
// memberStore → handlers → commandParser. This file only moves bytes.
//
// Deliberately absent, because none of it applies without a socket: reconnect/backoff,
// QR + pairing + the scan page, LID↔phone mapping, warm-up, the scheduler, and the
// trial/removal/ghost/reminder/overdue engines. Those files stay on disk for bot-nitin.

const BOT_START_TIME = Date.now();
const API = 'https://api.telegram.org/bot';

// Telegram's own cap is 4096; chunkByChars already splits handler output at 3000
// (globalConfig.MAX_CHARS_PER_MSG), so this only catches a handler that ignored it.
const TG_MAX = 4000;

export async function startBot(config, log) {
  const token = config.telegramToken;
  const allowed = new Set(config.allowedTelegramIds || []);
  let offset = 0;
  let isShuttingDown = false;
  let me = null;

  async function api(method, body) {
    const res = await fetch(`${API}${token}/${method}`, {
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
    for (let i = 0; i < text.length; i += TG_MAX) {
      await api('sendMessage', {
        chat_id: chatId,
        text: text.slice(i, i + TG_MAX),
        disable_web_page_preview: true,
      });
    }
  }

  log.info('📊 Connecting to Google Sheets...');
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId, log);
  const store = createMemberStore(sheetClient, config.botName);
  // Same loud-failure contract as the WhatsApp path: pm2 restarts either way, but a silent
  // death at "Connecting to Google Sheets..." is indistinguishable from a hang in the logs.
  try {
    await store.initialize();
  } catch (err) {
    log.error(`❌ Google Sheets unreachable — ${err.message}`);
    log.error('   Checked: service-account.json, SHEET_ID, sheet shared with the service account, network/quota.');
    throw err;
  }
  log.info(`✅ Sheet loaded: ${store.getAll().length} members in cache`);

  const groupManager = createManualGroupManager(config, log);
  // The engine and socket slots are null: a Telegram bot constructs none of them, and
  // commandParser refuses every command that would have reached one.
  const commandParser = createCommandParser(
    store, groupManager, config, log, null, BOT_START_TIME,
    null, null, null, new Set(), null, null,
  );

  async function broadcast(text) {
    for (const id of allowed) {
      try { await send(id, text); }
      catch (err) { log.warn(`⚠️  Broadcast to ${id} failed: ${err.message}`); }
    }
  }

  async function handleMessage(msg) {
    const from = msg.from?.id;
    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();
    if (!from || !chatId || !text) return;

    // Bootstrap: allowedTelegramIds is empty, so nobody is an operator yet and there is
    // nothing to protect. Hand each person their own id so they can be enrolled, and run
    // no commands at all. Filling the list in config.json ends this mode on next restart.
    if (config.bootstrapMode) {
      log.warn(`🔑 SETUP — id=${from} name=${msg.from?.first_name || '?'} (add to allowedTelegramIds in bots/${config.botName}/config.json)`);
      await send(chatId,
        `🔑 Setup mode — this bot has no operators yet.\n\n` +
        `Your Telegram ID:\n${from}\n\n` +
        `Put it in bots/${config.botName}/config.json:\n` +
        `  "allowedTelegramIds": [${from}]\n\n` +
        `Add every operator's ID to that list, then restart the bot:\n` +
        `  pm2 restart ${config.botName}\n\n` +
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

    log.info(`📥 Command from ${from}: "${text.substring(0, 80)}"`);

    // Instant receipt for commands that do sheet writes or network calls before replying,
    // so the operator can tell it landed. Quick lookups answer immediately and skip this.
    if (isSlowCommand(text)) {
      const label = text.split(/\s+/).slice(0, 2).join(' ');
      try { await send(chatId, `⏳ Got it — working on "${label}"…`); }
      catch (err) { log.warn(`⚠️  Ack send failed: ${err.message}`); }
    }

    const reply = await commandParser.parse(text);
    if (!reply) return;

    // Handlers may return an array when output exceeds one message (dmlist, log). Send the
    // parts in order with a small gap so they arrive in sequence rather than racing.
    const parts = Array.isArray(reply) ? reply : [reply];
    try {
      for (const [i, part] of parts.entries()) {
        if (i > 0) await new Promise(res => setTimeout(res, 800));
        await send(chatId, part);
      }
      log.info(`📤 Reply sent to ${chatId} (${parts.length} msg, ${parts.join('').length} chars)`);
    } catch (err) {
      log.error(`❌ Send failed: ${err.message}`);
    }
  }

  // Long polling, not a webhook: no public URL, no TLS certificate, no inbound firewall
  // rule. Telegram holds the request open for up to 50s and returns as soon as anything
  // arrives, so this is idle almost all the time.
  async function poll() {
    while (!isShuttingDown) {
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
          catch (err) { log.error(`❌ Message error: ${err.message}`); }
        }
      } catch (err) {
        if (isShuttingDown) return;
        // 409 means another process is polling the same token — usually a stale pm2 copy.
        // Say so plainly; the generic retry below would otherwise hide it forever.
        if (err.code === 409) {
          log.error(`❌ ${err.message}\n   Another process is polling this bot token. Check: pm2 list`);
        } else if (err.code === 401) {
          // The token was revoked or regenerated in @BotFather mid-run. Retrying forever
          // is pointless and buries the reason; die and let pm2's backoff surface it.
          log.error(`❌ ${err.message}\n   Token no longer valid — re-issue it with /token in @BotFather and update the bot's .env.`);
          throw err;
        } else {
          log.warn(`⚠️  Poll failed: ${err.message}`);
        }
        await new Promise(res => setTimeout(res, 5000));
      }
    }
  }

  // Trimmed to what scripts/watchdog.js consumes. No /qr, /scan or /pair — there is
  // nothing to link.
  function startHttpServer() {
    const app = express();
    app.get('/ping', (_, res) => res.send('ALIVE'));
    app.get('/health', (_, res) => res.json({
      status: me ? 'healthy' : 'degraded',
      connected: !!me,
      loggedOut: false,       // a bot token cannot be unlinked — watchdog reads this field
      members: store.getAll().length,
      uptime: Date.now() - BOT_START_TIME,
    }));
    app.get('/status', (_, res) => res.json({
      botName: config.botName,
      transport: 'telegram',
      connected: !!me,
      loggedOut: false,
      qrAvailable: false,
      uptime: Date.now() - BOT_START_TIME,
    }));
    // Watchdog alert relay — loopback only, regardless of what the firewall allows.
    app.post('/alert', express.json(), async (req, res) => {
      const ip = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
        return res.status(403).json({ error: 'localhost only' });
      }
      const text = String(req.body?.text || '').slice(0, 4000);
      if (!text) return res.status(400).json({ error: 'text required' });
      await broadcast(text);
      res.json({ sent: true });
    });

    app.listen(config.statsPort, '0.0.0.0', () => {
      log.info(`🌐 HTTP server: http://localhost:${config.statsPort}`);
      log.info(`💚 Health:      http://localhost:${config.statsPort}/health`);
    });
  }

  function gracefulShutdown(signal) {
    log.info(`👋 ${signal} — shutting down`);
    isShuttingDown = true;
    log.info('✅ Shutdown complete');
    process.exit(0);
  }
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

  // getMe both validates the token and gives the operator the @username to open.
  try {
    me = await api('getMe');
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info(`🚀 ${config.botName} — Telegram transport`);
    log.info(`   Bot: @${me.username}   Operators: ${allowed.size}`);
    log.info(`   Groups: ${config.paidGroups.length} (WhatsApp — managed by hand)`);
    if (config.bootstrapMode) {
      log.warn('🔑 SETUP MODE — no operators configured yet. The bot will reply to anyone');
      log.warn(`   with their Telegram ID and run NO commands. Open https://t.me/${me.username},`);
      log.warn(`   send it anything, then put the IDs in bots/${config.botName}/config.json.`);
    }
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    log.error(`❌ Telegram token rejected — ${err.message}`);
    log.error('   Check TELEGRAM_TOKEN in the bot\'s .env, or re-issue it with /token in @BotFather.');
    throw err;
  }

  startHttpServer();
  await poll();
}
