import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';

import { createSheetClient } from './sheetClient.js';
import { createMemberStore } from './memberStore.js';
import { createGroupManager } from './groupManager.js';
import { createCommandParser } from './commandParser.js';
import { createScheduler } from './scheduler.js';
import { createReminderSender } from './reminderSender.js';
import { createOverdueEngine } from './overdueEngine.js';

const BOT_START_TIME = Date.now();

export async function startBot(config, log, authDir) {
  let sock = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isShuttingDown = false;
  let isConnecting = false;
  let authState = null;
  let saveCreds = null;
  let latestQR = null;
  let qrTimestamp = null;
  let commandParser = null;
  let schedulerStarted = false;
  const botSentIds = new Set();
  let ownerLidJid = null;

  const ownerJid = `${config.ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`;
  log.info(`👑 Owner JID: ${ownerJid}`);

  // Allowed JIDs for fromMe=false command path — phone format + explicit LID overrides
  const allowedCommandJids = new Set([
    ...(config.allowedNumbers || []).map(n => `91${n.replace(/\D/g, '').slice(-10)}@s.whatsapp.net`),
    ...(config.allowedLids    || []).map(lid => `${String(lid).replace(/@lid$/, '').split(':')[0]}@lid`),
  ]);
  if (allowedCommandJids.size > 0) {
    log.info(`📱 Allowed command JIDs: ${[...allowedCommandJids].join(', ')}`);
  }

  const getSock = () => sock;
  const scheduler = createScheduler(config, log);
  const reminderSender = createReminderSender(config, log);
  const overdueEngine = createOverdueEngine(config, log);
  const lidToPhoneJid = new Map(); // @lid → @s.whatsapp.net resolved from contacts sync

  log.info('📊 Connecting to Google Sheets...');
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId);
  const store = createMemberStore(sheetClient, config.botName);
  await store.initialize();
  log.info(`✅ Sheet loaded: ${store.getAll().length} members in cache`);

  function destroySocket(reason) {
    if (!sock) return;
    log.info(`🔌 Destroying socket: ${reason}`);
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch (err) {
      log.warn(`⚠️  Socket teardown: ${err.message}`);
    }
    sock = null;
  }

  function scheduleReconnect(reason) {
    if (isShuttingDown) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 60000);
    reconnectAttempts++;

    if (reconnectAttempts > 10) {
      log.error('❌ Max reconnect attempts reached');
      process.exit(1);
    }

    log.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts}) [${reason}]`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await connectToWhatsApp();
    }, delay);
  }

  async function handleMessage(msg) {
    const jid = msg.key.remoteJid || '';
    const isPhone = jid.endsWith('@s.whatsapp.net');
    const isLid   = jid.endsWith('@lid');

    // Only handle direct messages — not groups, broadcasts, status
    if (!isPhone && !isLid) return;

    let replyJid;

    if (msg.key.fromMe) {
      // Self-chat (Saved Messages) — bot is sending to itself
      if (botSentIds.has(msg.key.id)) return;
      const isSelfPhone = isPhone && jid === ownerJid;
      const isSelfLid   = isLid   && jid === ownerLidJid;
      if (!isSelfPhone && !isSelfLid) return;
      replyJid = ownerJid;
    } else {
      // For @lid JIDs, resolve to phone JID first (WhatsApp routes via LID in multi-device)
      const resolvedJid = (isLid && lidToPhoneJid.has(jid)) ? lidToPhoneJid.get(jid) : jid;
      if (!allowedCommandJids.has(jid) && !allowedCommandJids.has(resolvedJid)) {
        const lidNum = jid.replace('@lid', '').split(':')[0];
        log.warn(`🚫 Non-allowed: ${jid}`);
        if (isLid) log.warn(`   To allow: add "${lidNum}" to config allowedLids array`);
        return;
      }
      replyJid = jid; // reply to whatever JID they messaged from
    }

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    log.info(`📥 Command from ${jid}: "${text.substring(0, 80)}"`);

    const reply = await commandParser.parse(text);
    if (reply) {
      try {
        const sent = await sock.sendMessage(replyJid, { text: reply });
        if (sent?.key?.id) {
          botSentIds.add(sent.key.id);
          if (botSentIds.size > 100) botSentIds.delete(botSentIds.values().next().value);
        }
        log.info(`📤 Reply sent to ${replyJid} (${reply.length} chars)`);
      } catch (err) {
        log.error(`❌ Send failed: ${err.message}`);
      }
    }
  }

  async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    if (sock) destroySocket('reconnect');

    try {
      if (!authState) {
        log.info('🔐 Loading auth state...');
        const { state, saveCreds: sc } = await useMultiFileAuthState(authDir);
        authState = state;
        saveCreds = sc;
      }

      const { version } = await fetchLatestBaileysVersion();
      log.info(`📦 Baileys version: ${version.join('.')}`);

      const baileysLogger = pino({ level: 'silent' });

      sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, baileysLogger),
        },
        logger: baileysLogger,
        printQRInTerminal: true,
        browser: ['Member Bot', 'Chrome', '120.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
      });

      const groupManager = createGroupManager(sock, config, log);
      commandParser = createCommandParser(store, groupManager, config, log, sock, BOT_START_TIME);

      // Build LID → phone JID map from contacts sync (fires on startup)
      const syncContacts = (contacts) => {
        for (const c of contacts) {
          if (!c.id || !c.lid) continue;
          // Normalize LID: strip device suffix, ensure @lid suffix
          const rawLid = String(c.lid).split(':')[0].replace(/@lid$/, '');
          const lidJid = `${rawLid}@lid`;
          // c.id is phone JID (@s.whatsapp.net) when c.lid is the LID
          if (c.id.endsWith('@s.whatsapp.net')) {
            lidToPhoneJid.set(lidJid, c.id);
          }
        }
      };
      sock.ev.on('contacts.upsert', (contacts) => { syncContacts(contacts); });
      sock.ev.on('contacts.update', (contacts) => { syncContacts(contacts); });
      sock.ev.on('messaging-history.set', ({ contacts }) => { if (contacts?.length) syncContacts(contacts); });

      sock.ev.on('creds.update', async () => { if (saveCreds) await saveCreds(); });

      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          log.info('📱 QR Code generated — scan with WhatsApp');
          latestQR = qr;
          qrTimestamp = Date.now();
          const qrTerminal = (await import('qrcode-terminal')).default;
          qrTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
          log.info('✅ CONNECTED — Member Bot operational');
          log.info(`👑 Owner: ${ownerJid}`);
          const rawLid = sock.user?.lid;
          ownerLidJid = rawLid ? `${String(rawLid).split(':')[0]}@lid` : null;
          if (ownerLidJid) log.info(`🪪 Owner LID: ${ownerLidJid}`);
          latestQR = null;
          reconnectAttempts = 0;
          await store.refresh();
          log.info(`📊 Cache refreshed: ${store.getAll().length} members`);

          // Resolve allowed numbers → actual JIDs (WhatsApp may route as @lid)
          for (const phone of config.allowedNumbers || []) {
            try {
              const normalized = `91${phone.replace(/\D/g, '').slice(-10)}`;
              const results = await sock.onWhatsApp(normalized);
              if (results?.[0]?.exists && results[0].jid) {
                allowedCommandJids.add(results[0].jid);
                log.info(`📱 ${phone} → ${results[0].jid}`);
              }
            } catch (err) {
              log.warn(`⚠️  Could not resolve JID for ${phone}: ${err.message}`);
            }
          }

          // Start scheduler once (survives reconnects)
          if (!schedulerStarted) {
            schedulerStarted = true;
            scheduler.start({
              morningDigest: async () => {
                if (!getSock()?.user) return;
                const { createReportHandlers } = await import('./handlers/reportHandlers.js');
                const reportH = createReportHandlers(store, config, BOT_START_TIME, log);
                const msg = reportH.handleSummary([]);
                await getSock().sendMessage(ownerJid, { text: `☀️ Morning Digest\n\n${msg}` });
              },
              reminderSend: async () => {
                await reminderSender.sendReminders(store, getSock, config.botDir);
              },
              overdueCheck: async () => {
                await overdueEngine.runOverdueCheck(store, getSock, ownerJid);
              },
              eveningSummary: async () => {
                if (!getSock()?.user) return;
                const { createReportHandlers } = await import('./handlers/reportHandlers.js');
                const reportH = createReportHandlers(store, config, BOT_START_TIME, log);
                const msg = reportH.handleSummary([]);
                await getSock().sendMessage(ownerJid, { text: `🌙 Evening Summary\n\n${msg}` });
              },
            });
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          log.warn(`⚠️  Connection closed — status ${statusCode}`);
          destroySocket('closed');

          if (statusCode === DisconnectReason.loggedOut) {
            log.error('❌ LOGGED OUT — delete baileys_auth/ and restart');
            process.exit(1);
          }

          scheduleReconnect(`statusCode=${statusCode}`);
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          try { await handleMessage(msg); }
          catch (err) { log.error(`❌ Message error: ${err.message}`); }
        }
      });

    } catch (err) {
      log.error(`❌ Connection error: ${err.message}`);
      scheduleReconnect('connection error');
    } finally {
      isConnecting = false;
    }
  }

  function startHttpServer() {
    const app = express();
    const port = config.statsPort;

    app.get('/ping', (_, res) => res.send('ALIVE'));
    app.get('/health', (_, res) => res.json({
      status: sock?.user ? 'healthy' : 'degraded',
      connected: !!sock?.user,
      members: store.getAll().length,
      uptime: Date.now() - BOT_START_TIME,
    }));
    app.get('/qr', async (req, res) => {
      if (!latestQR) return res.status(404).send('No QR — bot may already be connected.');
      if (Date.now() - (qrTimestamp || 0) > 20000) return res.status(410).send('QR expired — wait for new one.');
      const img = await QRCode.toBuffer(latestQR, { type: 'png', width: 400, margin: 2 });
      res.type('png').send(img);
    });

    app.listen(port, '0.0.0.0', () => {
      log.info(`🌐 HTTP server: http://localhost:${port}`);
      log.info(`📱 QR page:     http://localhost:${port}/qr`);
      log.info(`💚 Health:      http://localhost:${port}/health`);
    });
  }

  async function gracefulShutdown(signal) {
    log.info(`👋 ${signal} — shutting down`);
    isShuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    scheduler.stop();
    destroySocket('shutdown');
    log.info('✅ Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`🚀 ${config.botName} — Member Management Bot`);
  log.info(`   Groups: ${config.paidGroups.length} | Owner DM only`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startHttpServer();
  await connectToWhatsApp();
}
