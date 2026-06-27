import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

// Silence Baileys/libsignal Signal Protocol noise — these bypass pino and write directly to stdout
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  if (
    str.includes('Closing session:') ||
    str.includes('Removing old closed session:') ||
    str.includes('Session error:') ||
    str.includes('Bad MAC') ||
    str.includes('Closing open session in favor of') ||
    str.includes('/libsignal/')
  ) {
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  }
  return _origStdoutWrite(chunk, encoding, callback);
};

import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';

import { createSheetClient } from './sheetClient.js';
import { createMemberStore } from './memberStore.js';
import { createGroupManager } from './groupManager.js';
import { createCommandParser, isSlowCommand } from './commandParser.js';
import { createScheduler } from './scheduler.js';
import { createReminderSender } from './reminderSender.js';
import { createOverdueEngine } from './overdueEngine.js';
import { createTrialRemovalEngine } from './trialRemovalEngine.js';
import { createRemovalEngine } from './removalEngine.js';
import { createGhostRemovalEngine } from './ghostRemovalEngine.js';

const BOT_START_TIME = Date.now();

export async function startBot(config, log, authDir) {
  let sock = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isShuttingDown = false;
  let isConnecting = false;
  let loggedOut = false;   // set on a 401 — halts all reconnects until manual re-link
  let authState = null;
  let saveCreds = null;
  let latestQR = null;
  let qrTimestamp = null;
  let commandParser = null;
  let schedulerStarted = false;
  const seenMessageIds = new Map();     // msg id → timestamp, prevents double-processing duplicates
  const DEDUP_TTL_MS = 60 * 1000;      // evict after 60s

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
  const adminLids = new Set();   // raw numeric LIDs of allowedNumbers, auto-resolved on connect
  const trialEngine = createTrialRemovalEngine(config, log, getSock, getBroadcastJids, adminLids);

  log.info('📊 Connecting to Google Sheets...');
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId);
  const store = createMemberStore(sheetClient, config.botName);
  await store.initialize();
  log.info(`✅ Sheet loaded: ${store.getAll().length} members in cache`);

  const removalEngine = createRemovalEngine(config, log, getSock, store, getBroadcastJids);
  const ghostEngine = createGhostRemovalEngine(config, log, getSock, store, getBroadcastJids);

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
    if (isShuttingDown || loggedOut) return;
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

  function isDuplicateMessage(id) {
    if (!id) return false;
    const now = Date.now();
    for (const [k, ts] of seenMessageIds) {
      if (now - ts > DEDUP_TTL_MS) seenMessageIds.delete(k);
    }
    if (seenMessageIds.has(id)) return true;
    seenMessageIds.set(id, now);
    return false;
  }

  async function handleMessage(msg) {
    const jid = msg.key.remoteJid || '';

    // Ignore group messages, broadcasts, status updates
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;

    // Ignore self-sent messages entirely (no self-chat)
    if (msg.key.fromMe) return;

    // Deduplicate — WhatsApp sometimes delivers the same message event twice
    if (isDuplicateMessage(msg.key.id)) {
      log.warn(`⚠️  Duplicate message ${msg.key.id} — skipped`);
      return;
    }

    // WhatsApp stamps every @lid message with the sender's real phone JID (key.senderPn).
    // Use it for the allow-list check; fall back to our connect-time map, else the raw jid.
    const resolvedJid =
      msg.key?.senderPn ||
      (jid.endsWith('@lid') && lidToPhoneJid.has(jid) ? lidToPhoneJid.get(jid) : jid);
    // Reply to the PHONE JID, not the raw @lid. Sending to @lid makes Baileys usync the
    // recipient's devices over LID and build a fresh outbound session — that path is new and
    // flaky: when it resolves no devices it encrypts to nobody, so sendMessage succeeds and
    // logs "sent" but nothing is delivered. The PN send path is mature and reliable.
    // ponytail: senderPn → mapped PN → incoming jid.
    const replyJid = msg.key?.senderPn || (jid.endsWith('@lid') ? lidToPhoneJid.get(jid) : null) || jid;

    // Early reject — only allowedCommandJids (allowedNumbers, auto-resolved to JID + LID
    // at connect) may command the bot. Anyone else is silently ignored.
    if (!allowedCommandJids.has(jid) && !allowedCommandJids.has(resolvedJid)) return;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    log.info(`📥 Command from ${jid}: "${text.substring(0, 80)}"`);

    // Capture the socket reference now — if it changes during a long op (e.g. 401 mid-Add),
    // we detect it at send time and drop the reply rather than crashing on the new socket.
    const activeSock = sock;

    // Instant receipt ack for slow/mutating commands (add, approve, renewed, kick, …) so the
    // operator can tell the command actually reached the bot — the real result still follows
    // once the work finishes. Quick lookups reply directly and are skipped here.
    if (isSlowCommand(text)) {
      const label = text.trim().split(/\s+/).slice(0, 2).join(' ');
      try {
        if (activeSock === sock && sock?.user) {
          await sock.sendMessage(replyJid, { text: `⏳ Got it — working on "${label}"…` });
        }
      } catch (err) {
        log.warn(`⚠️  Ack send failed: ${err.message}`);
      }
    }

    const reply = await commandParser.parse(text);
    if (reply) {
      try {
        if (activeSock !== sock || !sock?.user) {
          log.warn(`⚠️  Session ended while processing "${text.substring(0, 40)}" — reply dropped`);
          return;
        }
        await sock.sendMessage(replyJid, { text: reply });
        log.info(`📤 Reply sent to ${replyJid} (${reply.length} chars)`);
      } catch (err) {
        log.error(`❌ Send failed: ${err.message}`);
      }
    }
  }

  async function connectToWhatsApp() {
    if (isConnecting || loggedOut) return;
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
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
      });

      const groupManager = createGroupManager(sock, config, log);
      commandParser = createCommandParser(store, groupManager, config, log, sock, BOT_START_TIME, trialEngine, removalEngine, ghostEngine, adminLids);

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
          trialEngine.resume();
          removalEngine.resume();
          ghostEngine.resume();
          // Catch up any reminder window the bot was offline/restarting across. Same restart-safe
          // pattern as removalEngine: persistent per-day state + per-phone dedupe, so missed
          // reminders go out on reconnect and nobody is ever messaged twice.
          reminderSender.resume(store, getSock, config.botDir, broadcast);
          overdueEngine.resume(store, getSock, getBroadcastJids);

          // Resolve allowedNumbers to actual JIDs (WhatsApp may route as @lid)
          for (const phone of config.allowedNumbers || []) {
            try {
              const normalized = `91${phone.replace(/\D/g, '').slice(-10)}`;
              const results = await sock.onWhatsApp(normalized);
              if (results?.[0]?.exists && results[0].jid) {
                allowedCommandJids.add(results[0].jid);
                // WhatsApp now delivers individual messages from the sender's @lid, not their
                // phone JID — register the LID too or commands from this number get early-rejected.
                if (results[0].lid) {
                  const rawLid = String(results[0].lid).replace(/@lid$/, '').split(':')[0];
                  const lidJid = `${rawLid}@lid`;
                  allowedCommandJids.add(lidJid);
                  lidToPhoneJid.set(lidJid, results[0].jid);
                  adminLids.add(rawLid);   // feeds trial-protection + audit counting
                }
                log.info(`📱 ${phone} → ${results[0].jid}${results[0].lid ? ` (lid ${results[0].lid})` : ''}`);
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
                const result = await reminderSender.sendReminders(store, getSock, config.botDir);
                if (result.autoRenewed?.length > 0) {
                  const lines = result.autoRenewed.map(m => `  • ${m.name}  ${m.phone}${m.rolled ? ` (+${m.rolled} ref rolled to next month)` : ''}`).join('\n');
                  await broadcast(`🎁 Auto-renewed (2 refs) — no reminder sent:\n${lines}`);
                }
              },
              reminderSend2: async () => {
                const result = await reminderSender.sendRemindersSecondBatch(store, getSock, config.botDir);
                if (result.autoRenewed?.length > 0) {
                  const lines = result.autoRenewed.map(m => `  • ${m.name}  ${m.phone}${m.rolled ? ` (+${m.rolled} ref rolled to next month)` : ''}`).join('\n');
                  await broadcast(`🎁 Auto-renewed (2 refs) — batch 2:\n${lines}`);
                }
              },
              overdueCheck: async () => {
                await overdueEngine.runOverdueCheck(store, getSock, getBroadcastJids());
              },
              eveningSummary: async () => {
                if (!getSock()?.user) return;
                const { createReportHandlers } = await import('./handlers/reportHandlers.js');
                const reportH = createReportHandlers(store, config, BOT_START_TIME, log);
                await broadcast(`🌙 Evening Summary\n\n${await reportH.handleSummary()}`);
              },
            });
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          log.warn(`⚠️  Connection closed — status ${statusCode}`);
          destroySocket('closed');
          // Abort in-flight group ops on ANY disconnect — prevents dead-socket
          // operations continuing after 408 timeout or other non-401 closures
          groupManager.markAborted();

          if (statusCode === DisconnectReason.loggedOut) {
            // 401 = WhatsApp forcibly unlinked this device. On a fresh/low-trust
            // number this usually means the account is restricted or temp-banned.
            // DO NOT auto-wipe auth and loop a fresh QR: repeatedly re-linking a
            // flagged number escalates a temporary restriction toward a permanent
            // ban. Halt all reconnects, preserve auth for inspection, and require
            // a deliberate manual re-link once the operator has confirmed the
            // number is healthy again.
            loggedOut = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            log.error('❌ LOGGED OUT by WhatsApp (401) — device unlinked. Reconnects HALTED.');
            log.error('   This number is likely restricted/temp-banned. Do NOT keep rescanning it.');
            log.error('   To re-link AFTER the number is confirmed healthy:');
            log.error(`     1) pm2 stop ${config.botName}`);
            log.error(`     2) delete the auth folder:  ${authDir}`);
            log.error(`     3) pm2 start ${config.botName}  and scan the QR once`);
            return;
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
      status: sock?.user ? 'healthy' : (loggedOut ? 'logged-out' : 'degraded'),
      connected: !!sock?.user,
      loggedOut,
      members: store.getAll().length,
      uptime: Date.now() - BOT_START_TIME,
    }));
    // Status contract consumed by the scan page (mirrors whatsapp-multibot /status).
    app.get('/status', (_, res) => res.json({
      botName: config.botName,
      connected: !!sock?.user,
      loggedOut,
      qrAvailable: !loggedOut && !!latestQR && (Date.now() - (qrTimestamp || 0) < 60000),
      uptime: Date.now() - BOT_START_TIME,
    }));
    app.get('/qr', async (req, res) => {
      if (!latestQR) return res.status(404).send('No QR — bot may already be connected.');
      if (Date.now() - (qrTimestamp || 0) > 60000) return res.status(410).send('QR expired — wait for new one.');
      const img = await QRCode.toBuffer(latestQR, { type: 'png', width: 400, margin: 2 });
      res.type('png').send(img);
    });

    // Shareable scan page (whatsapp-multibot style) — hand the URL to whoever owns the phone.
    // Polls /status; only loads the QR image when one is available, and degrades gracefully
    // to "Waiting for QR code…" instead of a broken image during the QR-rotation gaps.
    app.get(['/', '/scan'], (_, res) => {
      res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>📱 ${config.botName} — Scan QR</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .container{background:#fff;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:480px;width:100%;text-align:center}
  .bot-header{display:flex;align-items:center;justify-content:center;margin-bottom:24px}
  .bot-icon{font-size:3.4em;margin-right:16px}
  .bot-info h1{font-size:1.8em;color:#333;margin-bottom:4px}
  .bot-info .port{color:#888;font-size:.85em}
  .status{padding:14px 24px;border-radius:10px;font-size:1.05em;font-weight:600;margin:18px 0;display:inline-block}
  .status.connected{background:#d4edda;color:#155724}
  .status.waiting{background:#fff3cd;color:#856404}
  .status.error{background:#f8d7da;color:#721c24}
  .qr-container{margin:26px 0;min-height:300px;display:flex;align-items:center;justify-content:center;background:#f8f9fa;border-radius:12px;padding:20px}
  #qr-image{max-width:100%;height:auto;border-radius:10px;box-shadow:0 5px 15px rgba(0,0,0,.1)}
  .loading-text{color:#888;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .instructions{background:#f8f9fa;padding:18px;border-radius:10px;margin:18px 0;text-align:left}
  .instructions h3{color:#333;margin-bottom:12px;font-size:1.1em}
  .instructions ol{margin-left:20px;color:#666;line-height:1.8}
  .btn{padding:14px 24px;border:none;border-radius:10px;font-size:1em;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;margin-top:10px}
  .btn:hover{opacity:.9}
  .hidden{display:none}
</style></head><body>
<div class="container">
  <div class="bot-header">
    <div class="bot-icon">📱</div>
    <div class="bot-info">
      <h1>${config.botName}</h1>
      <div class="port">Link WhatsApp account</div>
    </div>
  </div>
  <div id="status" class="status waiting">⏳ Loading…</div>
  <div class="qr-container">
    <img id="qr-image" class="hidden" alt="QR Code">
    <div id="loading-text" class="loading-text">Waiting for QR code…</div>
  </div>
  <div class="instructions" id="instructions">
    <h3>📱 How to connect</h3>
    <ol>
      <li>Open WhatsApp on your phone</li>
      <li>Tap <strong>Settings → Linked devices</strong></li>
      <li>Tap <strong>Link a device</strong></li>
      <li>Point your phone at the QR above</li>
    </ol>
  </div>
  <button class="btn" onclick="refreshNow()">🔄 Refresh Now</button>
</div>
<script>
  var connected=false;
  var statusEl=document.getElementById('status');
  var img=document.getElementById('qr-image');
  var loadingText=document.getElementById('loading-text');
  var instructions=document.getElementById('instructions');
  function setStatus(cls,text){ statusEl.className='status '+cls; statusEl.textContent=text; }
  function loadQR(){
    img.onload=function(){ img.classList.remove('hidden'); loadingText.classList.add('hidden'); };
    img.onerror=function(){ img.classList.add('hidden'); loadingText.classList.remove('hidden'); loadingText.textContent='Waiting for QR code…'; };
    img.src='/qr?t='+Date.now();
  }
  function refreshNow(){ if(!connected) tick(); }
  async function tick(){
    try{
      var d=await (await fetch('/status',{cache:'no-store'})).json();
      if(d.connected){
        connected=true;
        setStatus('connected','✅ Connected to WhatsApp!');
        img.classList.add('hidden');
        loadingText.classList.remove('hidden');
        loadingText.classList.remove('loading-text');
        loadingText.textContent='Connected — you can close this page.';
        instructions.classList.add('hidden');
        return;
      }
      if(d.qrAvailable){
        setStatus('waiting','📱 Scan this QR with WhatsApp');
        loadQR();
      } else {
        setStatus('waiting','⏳ Waiting for QR code…');
        img.classList.add('hidden');
        loadingText.classList.remove('hidden');
        loadingText.textContent='Bot is starting, please wait…';
      }
    }catch(e){
      setStatus('error','❌ Bot offline or unreachable');
      img.classList.add('hidden');
      loadingText.classList.remove('hidden');
      loadingText.textContent='Cannot reach bot — check pm2 status.';
    }
  }
  tick();
  setInterval(function(){ if(!connected) tick(); },4000);
</script>
</body></html>`);
    });

    app.listen(port, '0.0.0.0', () => {
      log.info(`🌐 HTTP server: http://localhost:${port}`);
      log.info(`📱 Scan page:   http://localhost:${port}/   (shareable)`);
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
