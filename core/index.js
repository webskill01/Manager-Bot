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

  // Allowed LID JIDs — only these can send commands (no self-chat)
  const allowedCommandJids = new Set([
    ...(config.allowedNumbers || []).map(n => `91${n.replace(/\D/g, '').slice(-10)}@s.whatsapp.net`),
    ...(config.allowedLids    || []).map(lid => `${String(lid).replace(/@lid$/, '').split(':')[0]}@lid`),
  ]);
  log.info(`📱 Allowed command JIDs (${allowedCommandJids.size}): ${[...allowedCommandJids].join(', ')}`);

  // JIDs that receive proactive broadcasts (morning digest, evening summary)
  const broadcastJids = [
    ...(config.allowedNumbers || []).map(n => `91${n.replace(/\D/g, '').slice(-10)}@s.whatsapp.net`),
  ];
  // Always deduplicate broadcastJids
  const broadcastSet = new Set(broadcastJids);
  const getBroadcastJids = () => [...broadcastSet];

  const getSock = () => sock;
  const scheduler = createScheduler(config, log);
  const reminderSender = createReminderSender(config, log);
  const overdueEngine = createOverdueEngine(config, log);
  const lidToPhoneJid = new Map();

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

  async function broadcast(text) {
    const s = getSock();
    if (!s?.user) return;
    for (const jid of getBroadcastJids()) {
      try {
        await s.sendMessage(jid, { text });
      } catch (err) {
        log.warn(`⚠️  Broadcast failed to ${jid}: ${err.message}`);
      }
    }
  }

  async function handleMessage(msg) {
    const jid = msg.key.remoteJid || '';

    // Ignore group messages, broadcasts, status updates
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;

    // Ignore self-sent messages entirely (no self-chat)
    if (msg.key.fromMe) return;

    // Resolve @lid to phone JID if we have the mapping
    const resolvedJid = (jid.endsWith('@lid') && lidToPhoneJid.has(jid)) ? lidToPhoneJid.get(jid) : jid;

    // Early reject — only allowedCommandJids can send commands
    if (!allowedCommandJids.has(jid) && !allowedCommandJids.has(resolvedJid)) return;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    log.info(`📥 Command from ${jid}: "${text.substring(0, 80)}"`);

    const reply = await commandParser.parse(text);
    if (reply) {
      try {
        await sock.sendMessage(jid, { text: reply });
        log.info(`📤 Reply sent to ${jid} (${reply.length} chars)`);
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

      const syncContacts = (contacts) => {
        for (const c of contacts) {
          if (!c.id || !c.lid) continue;
          const rawLid = String(c.lid).split(':')[0].replace(/@lid$/, '');
          const lidJid = `${rawLid}@lid`;
          if (c.id.endsWith('@s.whatsapp.net')) {
            lidToPhoneJid.set(lidJid, c.id);
          }
        }
      };
      sock.ev.on('contacts.upsert',       (contacts) => syncContacts(contacts));
      sock.ev.on('contacts.update',       (contacts) => syncContacts(contacts));
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
          latestQR = null;
          reconnectAttempts = 0;
          await store.refresh();
          log.info(`📊 Cache refreshed: ${store.getAll().length} members`);

          // Resolve allowedNumbers to actual JIDs (WhatsApp may route as @lid)
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
                await broadcast(reportH.handleMorningDigest());
              },
              reminderSend: async () => {
                await reminderSender.sendReminders(store, getSock, config.botDir);
              },
              reminderSend2: async () => {
                await reminderSender.sendRemindersSecondBatch(store, getSock, config.botDir);
              },
              overdueCheck: async () => {
                await overdueEngine.runOverdueCheck(store, getSock, getBroadcastJids());
              },
              eveningSummary: async () => {
                if (!getSock()?.user) return;
                const { createReportHandlers } = await import('./handlers/reportHandlers.js');
                const reportH = createReportHandlers(store, config, BOT_START_TIME, log);
                await broadcast(`🌙 Evening Summary\n\n${reportH.handleSummary()}`);
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

  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`🚀 ${config.botName} — Member Management Bot`);
  log.info(`   Groups: ${config.paidGroups.length} | LID-only command mode`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startHttpServer();
  await connectToWhatsApp();
}
