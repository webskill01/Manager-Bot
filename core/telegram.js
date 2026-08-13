import express from 'express';

import { createSheetClient } from './sheetClient.js';
import { createMemberStore } from './memberStore.js';
import { createManualGroupManager } from './manualGroupManager.js';
import { createCommandParser } from './commandParser.js';
import { createTelegramListener } from './telegramTransport.js';

// Telegram-only transport — the operator-facing half of a tracker bot, replacing core/index.js.
//
// Why this exists: Baileys is an unofficial WhatsApp client, and running one is how a
// number gets flagged (bot-abhi already ate a 403). Tracker bots stopped sending anything
// on a schedule long ago — they read the sheet, write the sheet, and print reports when
// commanded. None of that needs WhatsApp. Moving the operator to Telegram's official Bot
// API removes the ban risk entirely, and the members never have to move: they stay in the
// same WhatsApp groups, and the operator does group work by hand (see manualGroupManager).
//
// Everything below the transport is shared verbatim with the WhatsApp path: sheetClient →
// memberStore → handlers → commandParser. This file only wires them together; the polling
// and sending live in telegramTransport.js, shared with bot-nitin's dual transport.
//
// Deliberately absent, because none of it applies without a socket: reconnect/backoff,
// QR + pairing + the scan page, LID↔phone mapping, warm-up, the scheduler, and the
// trial/removal/ghost/reminder/overdue engines. Those files stay on disk for bot-nitin.

const BOT_START_TIME = Date.now();

export async function startBot(config, log) {
  let isShuttingDown = false;

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

  const telegram = createTelegramListener({
    token: config.telegramToken,
    allowedIds: config.allowedTelegramIds,
    bootstrapMode: config.bootstrapMode,
    botName: config.botName,
    log,
    onCommand: async (text, reply) => {
      try {
        await reply(await commandParser.parse(text));
      } catch (err) {
        log.error(`❌ Send failed: ${err.message}`);
      }
    },
  });

  // Trimmed to what scripts/watchdog.js consumes. No /qr, /scan or /pair — there is
  // nothing to link.
  function startHttpServer() {
    const connected = () => !!telegram.getMe();
    const app = express();
    app.get('/ping', (_, res) => res.send('ALIVE'));
    app.get('/health', (_, res) => res.json({
      status: connected() ? 'healthy' : 'degraded',
      connected: connected(),
      loggedOut: false,       // a bot token cannot be unlinked — watchdog reads this field
      members: store.getAll().length,
      uptime: Date.now() - BOT_START_TIME,
    }));
    app.get('/status', (_, res) => res.json({
      botName: config.botName,
      transport: 'telegram',
      connected: connected(),
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
      await telegram.broadcast(text);
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
    telegram.stop();
    log.info('✅ Shutdown complete');
    process.exit(0);
  }
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

  const me = await telegram.connect();
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`🚀 ${config.botName} — Telegram transport`);
  log.info(`   Bot: @${me.username}   Operators: ${telegram.operatorCount()}`);
  log.info(`   Groups: ${config.paidGroups.length} (WhatsApp — managed by hand)`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startHttpServer();
  // Telegram is this bot's only transport, so a revoked token means it can do nothing at
  // all. Let the rejection propagate and pm2's backoff surface it, exactly as before.
  await telegram.start();
  if (!isShuttingDown) log.warn('⚠️  Telegram polling stopped unexpectedly');
}
