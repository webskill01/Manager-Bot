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
import { createReminderSender, renderSendLog } from './reminderSender.js';
import { createOverdueEngine } from './overdueEngine.js';
import { createDeliveryTracker } from './deliveryTracker.js';
import { createDripEngine } from './dripEngine.js';
import { createLedger } from './ledger.js';
import { createTrialRemovalEngine } from './trialRemovalEngine.js';
import { createRemovalEngine } from './removalEngine.js';
import { createGhostRemovalEngine } from './ghostRemovalEngine.js';
// catchupEngine.js stays on disk but is deliberately NOT wired: every one of its stages
// posts a group @mention message, which is the path being retired. Reminders are manual
// (`dmlist`) until the Cloud API cutover. Delete the file once that has run a clean month.
import { isTracker } from './globalConfig.js';
import { usesCloudApi } from './cloudApiSender.js';
import { createTelegramListener } from './telegramTransport.js';
import { markLinkedAt, getLinkedAt, inWarmup } from './warmup.js';

const BOT_START_TIME = Date.now();

export async function startBot(config, log, authDir) {
  let sock = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isShuttingDown = false;
  let isConnecting = false;
  let loggedOut = false;   // set on a 401/403 — halts all reconnects until manual re-link
  let registeredAtLoad = null;   // was the auth already registered when loaded? false = fresh link this run
  let authState = null;
  let saveCreds = null;
  let latestQR = null;
  let qrTimestamp = null;
  let commandParser = null;
  let dripEngine = null;
  let schedulerStarted = false;
  // Second command channel, on `transport: "dual"` only (bot-nitin). It drives the SAME
  // commandParser and the SAME live socket, so `kick` typed in Telegram really removes the
  // member from every group — and when a 403 kills the socket, every sheet command still
  // answers. null on the four tracker bots and on plain WhatsApp bots.
  let telegram = null;
  const seenMessageIds = new Map();     // msg id → timestamp, prevents double-processing duplicates
  const DEDUP_TTL_MS = 60 * 1000;      // evict after 60s

  // Allowed LID JIDs — only these can send commands (no self-chat)
  const allowedCommandJids = new Set([
    ...(config.allowedNumbers || []).map(n => `91${n.replace(/\D/g, '').slice(-10)}@s.whatsapp.net`),
    ...(config.allowedLids    || []).map(lid => `${String(lid).replace(/@lid$/, '').split(':')[0]}@lid`),
  ]);
  log.info(`📱 Allowed command JIDs (${allowedCommandJids.size}): ${[...allowedCommandJids].join(', ')}`);

  // Warm-up: freshly linked numbers stay quiet (no engines, no scheduled sends,
  // delayed admin usync) for the first warmupHours so WhatsApp sees a normal
  // device, not a bot burst. Established links (no marker) are never warmed up.
  // Default raised 24 → 72 on 2026-07-27: at 24h a re-linked number went from total
  // silence to the full production schedule overnight, and the first thing the account
  // ever did was a 6 AM burst. Three days of quiet is cheap; a burned number is not.
  const warmupHours = config.warmupHours ?? 72;
  const warmingUp = () => inWarmup(authDir, warmupHours);

  // JIDs that receive command replies and engine progress reports (kickall, catch-up
  // completion, watchdog alerts). No longer used for scheduled digests — those are
  // pull-only commands now.
  const broadcastJids = [
    ...(config.allowedNumbers || []).map(n => `91${n.replace(/\D/g, '').slice(-10)}@s.whatsapp.net`),
  ];
  // Always deduplicate broadcastJids
  const broadcastSet = new Set(broadcastJids);
  const getBroadcastJids = () => [...broadcastSet];

  const getSock = () => sock;
  // Group metadata cache — serves Baileys' internal group-send path only (no metadata
  // query per group send). Explicit groupMetadata() calls always fetch live and repopulate
  // it; membership events and reconnects invalidate. ponytail: plain Map, no TTL needed.
  const groupMetaCache = new Map();
  // Watches message acks so the drip can tell a delivered reminder from one WhatsApp
  // merely accepted. Re-attached per socket below — listeners do not survive a reconnect.
  const deliveryTracker = createDeliveryTracker(log);
  const scheduler = createScheduler(config, log);
  const reminderSender = createReminderSender(config, log);
  // notifyTelegram is a hoisted function declaration, so passing it here — above its
  // definition — is fine, and it is what turns these engines' failures from a pm2 line
  // nobody reads into something that reaches a phone.
  const overdueEngine = createOverdueEngine(config, log, (t) => notifyTelegram(t, config.dripIds));
  const lidToPhoneJid = new Map();
  const adminLids = new Set();   // raw numeric LIDs of allowedNumbers, auto-resolved on connect
  const trialEngine = createTrialRemovalEngine(config, log, getSock, getBroadcastJids, adminLids);

  log.info('📊 Connecting to Google Sheets...');
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId, log);
  const store = createMemberStore(sheetClient, config.botName);
  const ledger = createLedger(config, store, log);

  // Built here, not inside the connection handler: in manual mode the drip sends nothing over
  // WhatsApp, so it must not be coupled to whether a socket ever comes up. On a flagged
  // number the drip is the ONLY thing still reminding anyone, which is exactly when it
  // matters most. notifyTelegram is a hoisted function declaration, so referencing it this
  // early is fine, and getSock is a getter — resolved per send, never captured here, so a
  // reconnect swaps the socket underneath it with nothing to rewire.
  //
  // The fourth argument is what unlocks "mode": "auto". core/telegram.js passes nothing in
  // its place, which is why a Telegram-only bot cannot auto-send however its config reads.
  if (!isTracker(config)) {
    dripEngine = createDripEngine(
      config, log, store, reminderSender,
      (text) => notifyTelegram(text, config.dripIds),
      { getSock, warmingUp, tracker: deliveryTracker },
    );
  }

  // The first read retries transient failures internally (see sheetClient.withRetry).
  // If it still fails, say so loudly and exit non-zero rather than dying with a bare
  // unhandled rejection — pm2 restarts either way, but a silent death at "Connecting to
  // Google Sheets..." is indistinguishable from a hang in the logs.
  try {
    await store.initialize();
  } catch (err) {
    log.error(`❌ Google Sheets unreachable — ${err.message}`);
    log.error('   Checked: service-account.json, SHEET_ID, sheet shared with the service account, network/quota.');
    throw err;
  }
  log.info(`✅ Sheet loaded: ${store.getAll().length} members in cache`);

  const removalEngine = createRemovalEngine(config, log, getSock, store, getBroadcastJids,
    (t) => notifyTelegram(t, config.dripIds));
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

  // Operator-facing broadcast: engine progress, watchdog alerts, reminder batch reports.
  // Goes to Telegram FIRST when a listener is running, because that is the channel that
  // still works when WhatsApp does not — a 403 alert delivered over the dead socket is an
  // alert nobody ever sees. WhatsApp delivery is best-effort on top.
  async function broadcast(text) {
    if (telegram) {
      try { await telegram.broadcast(text); }
      catch (err) { log.warn(`⚠️  Telegram broadcast failed: ${err.message}`); }
    }
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

  // Telegram-only delivery. The drip and the restored digests use this INSTEAD of
  // broadcast(), which writes to Telegram and then loops the WhatsApp socket — and that
  // WhatsApp half is exactly the 6 AM admin-DM traffic that got freshly linked numbers
  // banned in July. Nothing that runs on a timer may reach a member's phone through the
  // socket, so the two paths stay separate rather than one growing a flag.
  //
  // Returns false when no listener is running, so a token-less bot degrades to silence
  // rather than quietly falling back to WhatsApp.
  async function notifyTelegram(text, ids = null) {
    if (!telegram) return false;
    const targets = ids && ids.length ? ids : null;
    try {
      if (!targets) { await telegram.broadcast(text); return true; }
      for (const id of targets) {
        try { await telegram.send(id, text); }
        catch (err) { log.warn(`⚠️  Telegram send to ${id} failed: ${err.message}`); }
      }
      return true;
    } catch (err) {
      log.warn(`⚠️  Telegram notify failed: ${err.message}`);
      return false;
    }
  }

  // Proof a reminder run happened. On the Cloud API nothing lands on the operator's own
  // phone any more, so without this the only evidence is a pm2 log nobody reads at 6:30 AM.
  // Every member sent is listed with Meta's wamid, and every failure with Meta's own reason
  // and code — which is what separates "one number isn't on WhatsApp" (131026) from "the
  // token is dead" (190) or "the balance ran out". The Telegram chat then IS the record:
  // dated, permanent, and unaffected by log rotation.
  async function reportBatch(label, result) {
    if (!usesCloudApi(config)) return;
    try {
      const log_ = renderSendLog(config.botDir);
      const head = result
        ? `⏰ *${label}* — ${result.sent + result.referralSent} sent, ${result.failed} failed` +
          (result.autoRenewed?.length ? `, ${result.autoRenewed.length} auto-renewed (2 refs)` : '') +
          (result.queued ? `, ${result.queued} held for the next batch` : '')
        : `⏰ *${label}* done`;
      await broadcast(`${head}\n\n${log_}`);
    } catch (err) {
      // A failed report must never mask a successful send run.
      log.warn(`⚠️  Batch report failed: ${err.message}`);
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

    // Baileys 7.x stamps every DM with the sender's alternate address: key.remoteJidAlt is
    // the phone JID when the message arrived LID-addressed (and the LID when PN-addressed).
    // Use it for the allow-list check only (older builds called it senderPn).
    const altJid = String(msg.key?.remoteJidAlt || msg.key?.senderPn || '')
      .replace(/:\d+@/, '@');   // strip device suffix so it matches allowedCommandJids entries
    const mappedJid = jid.endsWith('@lid') ? lidToPhoneJid.get(jid) : null;
    // Reply to the EXACT JID the message arrived on — the Signal session that just decrypted
    // this message is keyed to it. Baileys 7.x maps PN↔LID sessions internally, so never remap.
    const replyJid = jid;

    // Early reject — only allowedCommandJids (allowedNumbers, auto-resolved to JID + LID
    // at connect) may command the bot. Anyone else is silently ignored.
    if (!allowedCommandJids.has(jid) &&
        !(altJid && allowedCommandJids.has(altJid)) &&
        !(mappedJid && allowedCommandJids.has(mappedJid))) return;

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
        // A handler may return an array when its output exceeds one WhatsApp message
        // (dmlist does). Send the parts in order with a small gap so they arrive in
        // sequence rather than racing.
        const replies = Array.isArray(reply) ? reply : [reply];
        for (const [i, part] of replies.entries()) {
          if (i > 0) await new Promise(res => setTimeout(res, 800));
          await sock.sendMessage(replyJid, { text: part });
        }
        log.info(`📤 Reply sent to ${replyJid} (${replies.length} msg, ${replies.join('').length} chars)`);
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
        registeredAtLoad = !!state.creds?.registered;
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
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined,
        cachedGroupMetadata: async (jid) => groupMetaCache.get(jid),
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
      });

      // Populate the send-path cache from every live metadata fetch; drop entries the
      // moment membership/subject changes so sends never encrypt against a stale roster.
      const liveGroupMetadata = sock.groupMetadata.bind(sock);
      sock.groupMetadata = async (jid) => {
        const meta = await liveGroupMetadata(jid);
        if (String(jid).endsWith('@g.us') && meta) groupMetaCache.set(jid, meta);
        return meta;
      };
      // Before any other listener: a receipt that arrives during connect must not be missed.
      deliveryTracker.attach(sock);
      sock.ev.on('group-participants.update', (u) => groupMetaCache.delete(u?.id));
      sock.ev.on('groups.update', (updates) => { for (const u of updates || []) groupMetaCache.delete(u?.id); });

      const groupManager = createGroupManager(sock, config, log);
      commandParser = createCommandParser(store, groupManager, config, log, sock, BOT_START_TIME, trialEngine, removalEngine, ghostEngine, adminLids, reminderSender, getSock, dripEngine, ledger);

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

      sock.ev.on('creds.update', async () => {
        // Registration completed during THIS run → start the warm-up clock. Bots that
        // loaded already-registered creds never get marked (no warm-up for old links).
        if (registeredAtLoad === false && authState?.creds?.registered) markLinkedAt(authDir);
        if (saveCreds) await saveCreds();
      });

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
          groupMetaCache.clear();   // roster may have changed while offline
          await store.refresh();
          log.info(`📊 Cache refreshed: ${store.getAll().length} members`);
          // Resolve allowedNumbers to actual JIDs (WhatsApp may route as @lid)
          const resolveAdminJids = async () => {
            for (const phone of config.allowedNumbers || []) {
              try {
                const normalized = `91${phone.replace(/\D/g, '').slice(-10)}`;
                const results = await sock.onWhatsApp(normalized);
                if (results?.[0]?.exists && results[0].jid) {
                  allowedCommandJids.add(results[0].jid);
                  // WhatsApp delivers DMs from the sender's @lid, not their phone JID — register
                  // the LID too or commands get early-rejected. Baileys 7.x dropped the .lid field
                  // from onWhatsApp; ask its LID mapping store instead (usyncs + caches).
                  let lid = null;
                  try { lid = await sock.signalRepository?.lidMapping?.getLIDForPN(results[0].jid); } catch {}
                  if (lid) {
                    const rawLid = String(lid).split('@')[0].split(':')[0];
                    const lidJid = `${rawLid}@lid`;
                    allowedCommandJids.add(lidJid);
                    lidToPhoneJid.set(lidJid, results[0].jid);
                    adminLids.add(rawLid);   // feeds trial-protection + audit counting
                  }
                  log.info(`📱 ${phone} → ${results[0].jid}${lid ? ` (lid ${lid})` : ''}`);
                }
              } catch (err) {
                log.warn(`⚠️  Could not resolve JID for ${phone}: ${err.message}`);
              }
            }
          };

          if (warmingUp()) {
            const until = new Date(getLinkedAt(authDir) + warmupHours * 3600e3);
            log.warn(`🐣 WARM-UP MODE — fresh link. Engines & scheduled sends paused until ${until.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Admin commands still work (auth via remoteJidAlt).`);
            // Spare the fresh session the connect-instant usync burst — resolve quietly later.
            const s = sock;
            setTimeout(() => { if (sock === s && s?.user) resolveAdminJids().catch(() => {}); }, 10 * 60 * 1000);
            // If this connection outlives the warm-up window, resume engines right then —
            // otherwise the next reconnect's 'open' handler does it.
            const msLeft = getLinkedAt(authDir) + warmupHours * 3600e3 - Date.now();
            setTimeout(() => {
              if (sock !== s || !s?.user) return;
              log.info('🐣 Warm-up over — resuming engines');
              trialEngine.resume();
              removalEngine.resume();
              ghostEngine.resume();
              // Same gate as the crons: resume() replays a missed reminder window, so
              // leaving it ungated would send Baileys reminders on every reconnect and
              // walk straight past the scheduler guard.
              if (!isTracker(config) && usesCloudApi(config)) {
                reminderSender.resume(store, getSock, config.botDir, broadcast);
                overdueEngine.resume(store, getSock, getBroadcastJids);
              }
              // NOT gated on usesCloudApi: the drip is what runs precisely while the Cloud
              // API is still blocked on billing, and it transmits nothing over WhatsApp.
              dripEngine?.resume();
            }, msLeft + 1000);
          } else {
            trialEngine.resume();
            removalEngine.resume();
            ghostEngine.resume();
            // Gated exactly like the crons — resume() replays a missed reminder window,
            // and an ungated replay would send Baileys reminders on every reconnect.
            if (!isTracker(config) && usesCloudApi(config)) {
              // Catch up any reminder window the bot was offline/restarting across. Same restart-safe
              // pattern as removalEngine: persistent per-day state + per-phone dedupe, so missed
              // reminders go out on reconnect and nobody is ever messaged twice.
              reminderSender.resume(store, getSock, config.botDir, broadcast);
              overdueEngine.resume(store, getSock, getBroadcastJids);
            }
            dripEngine?.resume();
            await resolveAdminJids();
          }

          // Start scheduler once (survives reconnects)
          if (!schedulerStarted) {
            schedulerStarted = true;
            const skipWarmup = (job) => {
              if (warmingUp()) { log.info(`🐣 Warm-up — skipped ${job}`); return true; }
              return false;
            };
            // No morningDigest / eveningSummary jobs — see the note in scheduler.js.
            // Auto-renewals are logged and surfaced by the `digest` command instead of
            // broadcast: an unprompted DM to every admin is the exact traffic that got
            // fresh numbers banned, and nobody needs it at 6:30 AM.
            //
            // Tracker bots register NO cron jobs whatsoever — they collect no renewals,
            // so there is nothing to send on a timer and the account only ever transmits
            // in response to an operator command.
            if (isTracker(config)) {
              log.info('📋 Tracker profile — no scheduled jobs registered (command-driven only)');
            } else scheduler.start({
              // Every scheduled job is a no-op until reminders run through the official
              // Cloud API. Reminders are sent BY HAND from the admin number in the
              // meantime (see the `dmlist` command) — a cron falling back to Baileys
              // DMs is the exact traffic that got numbers banned, so it must not happen
              // by accident. Flipping reminderChannel to "cloudapi" wakes all three.
              reminderSend: async () => {
                if (!usesCloudApi(config)) return log.info('⏰ Batch 1 skipped — manual reminder mode (use `dmlist`)');
                if (skipWarmup('reminder batch 1')) return;
                const result = await reminderSender.sendReminders(store, getSock, config.botDir);
                if (result.autoRenewed?.length > 0) {
                  log.info(`🎁 Auto-renewed (2 refs), batch 1: ${result.autoRenewed.map(m => `${m.name} ${m.phone}${m.rolled ? ` +${m.rolled} rolled` : ''}`).join(', ')}`);
                }
                await reportBatch('Reminder batch 1', result);
              },
              reminderSend2: async () => {
                if (!usesCloudApi(config)) return log.info('⏰ Batch 2 skipped — manual reminder mode (use `dmlist`)');
                if (skipWarmup('reminder batch 2')) return;
                const result = await reminderSender.sendRemindersSecondBatch(store, getSock, config.botDir);
                if (result.autoRenewed?.length > 0) {
                  log.info(`🎁 Auto-renewed (2 refs), batch 2: ${result.autoRenewed.map(m => `${m.name} ${m.phone}${m.rolled ? ` +${m.rolled} rolled` : ''}`).join(', ')}`);
                }
                await reportBatch('Reminder batch 2', result);
              },
              overdueCheck: async () => {
                if (!usesCloudApi(config)) return log.info('⏰ Overdue check skipped — manual reminder mode (use `dmlist`)');
                if (skipWarmup('overdue check')) return;
                await overdueEngine.runOverdueCheck(store, getSock, getBroadcastJids());
                await reportBatch('Overdue check', null);
              },

              // The three below exist ONLY when a Telegram listener is running, and they
              // deliver through notifyTelegram — never broadcast(), whose WhatsApp half is
              // the traffic that got numbers banned. A token-less bot spreads nothing here
              // and so registers none of these jobs at all. That absence IS the safety gate.
              ...(config.usesTelegram ? {
                morningDigest:  async () => { await notifyTelegram(await commandParser.runReport('digest')); },
                eveningSummary: async () => {
                  // Own row first, THEN read. The 9 PM ledger job already ran an hour ago, so
                  // this is belt-and-braces against the one case the hour of clearance cannot
                  // cover: this bot restarting between 21:00 and 22:00 and missing its own
                  // write. Cheap (a diff that usually writes nothing) and it cannot make the
                  // report worse. Never let a Sheets hiccup here cost the whole summary.
                  try { await ledger.writeToday(); }
                  catch (err) { log.warn(`⚠️  Pre-summary ledger write failed: ${err.message}`); }
                  await notifyTelegram(await commandParser.runReport('summary'));
                },
                // Not gated on warm-up: warm-up keeps a freshly linked WhatsApp number
                // quiet, and the drip never transmits on it.
                dripArm: () => dripEngine.arm(),
              } : {}),
              // Outside the usesTelegram gate on purpose: the ledger only writes to a Google
              // Sheet. It transmits nothing to any member, so the ban-risk reasoning that
              // gates the reports above simply does not apply to it.
              ledgerWrite: () => ledger.writeToday(),
              ledgerReconcile: () => ledger.reconcile(),
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

          if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
            // 401 = WhatsApp forcibly unlinked this device; 403 = account flagged/
            // forbidden. On a fresh/low-trust number either usually means the
            // account is restricted or temp-banned. Reconnect-looping into a 403
            // (as pm2 logs showed bot-abhi doing) escalates the restriction.
            // DO NOT auto-wipe auth and loop a fresh QR: repeatedly re-linking a
            // flagged number escalates a temporary restriction toward a permanent
            // ban. Halt all reconnects, preserve auth for inspection, and require
            // a deliberate manual re-link once the operator has confirmed the
            // number is healthy again.
            loggedOut = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            log.error(`❌ ${statusCode === 403 ? 'FORBIDDEN (403) — account flagged by WhatsApp' : 'LOGGED OUT by WhatsApp (401) — device unlinked'}. Reconnects HALTED.`);
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
      // Dual transport only. The watchdog reads `loggedOut` to decide whether to shout, and
      // that contract is unchanged — a 403 is still a real problem worth alerting on, even
      // though Telegram keeps the bookkeeping alive.
      telegram: telegram ? !!telegram.getMe() : undefined,
      members: store.getAll().length,
      uptime: Date.now() - BOT_START_TIME,
    }));
    // Status contract consumed by the scan page (mirrors whatsapp-multibot /status).
    app.get('/status', (_, res) => res.json({
      botName: config.botName,
      transport: config.transport,
      connected: !!sock?.user,
      loggedOut,
      telegram: telegram ? !!telegram.getMe() : undefined,
      qrAvailable: !loggedOut && !!latestQR && (Date.now() - (qrTimestamp || 0) < 60000),
      uptime: Date.now() - BOT_START_TIME,
    }));
    // Pairing-code login (alternative to QR): GET /pair?number=9198xxxxxx21
    // Only valid while the socket is in the QR/link-waiting phase. The code is
    // entered on the phone: WhatsApp → Linked devices → Link with phone number.
    app.get('/pair', async (req, res) => {
      try {
        if (sock?.user) return res.status(409).json({ error: 'Already connected — unlink first if you want to re-pair.' });
        if (loggedOut) return res.status(409).json({ error: 'Bot is halted after a 401/403 — clear the auth folder and restart first.' });
        if (!sock || !latestQR) return res.status(503).json({ error: 'Bot not ready for pairing yet — wait for the QR to appear, then retry.' });
        let digits = String(req.query.number || '').replace(/\D/g, '');
        if (digits.length === 10) digits = `91${digits}`;   // default to India like the rest of the bot
        if (digits.length < 11 || digits.length > 15) {
          return res.status(400).json({ error: 'Enter the 10-digit number (or full number with country code).' });
        }
        const code = await sock.requestPairingCode(digits);
        log.info(`🔗 Pairing code for ${digits}: ${code}`);
        res.json({ code, number: digits });
      } catch (err) {
        log.error(`❌ Pairing code failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // Watchdog alert relay — localhost-only. The watchdog process POSTs {text} here
    // and this bot broadcasts it to its allowedNumbers. Never exposed to the internet:
    // any non-loopback source is rejected regardless of what the firewall allows.
    app.post('/alert', express.json(), async (req, res) => {
      const ip = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
        return res.status(403).json({ error: 'localhost only' });
      }
      // A Telegram listener can deliver with no socket at all, and "the WhatsApp number
      // just got banned" is precisely the alert that must not be dropped for want of a
      // WhatsApp connection. Only refuse when there is genuinely no way out.
      if (!sock?.user && !telegram) return res.status(503).json({ error: 'not connected' });
      const text = String(req.body?.text || '').slice(0, 4000);
      if (!text) return res.status(400).json({ error: 'text required' });
      await broadcast(text);
      res.json({ sent: true });
    });

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
  .pair-section{background:#f8f9fa;padding:18px;border-radius:10px;margin:18px 0;text-align:left}
  .pair-section h3{color:#333;margin-bottom:12px;font-size:1.1em}
  .pair-section input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:1em;margin-bottom:10px;box-sizing:border-box}
  #pair-code{font-size:2em;font-weight:700;letter-spacing:5px;text-align:center;margin:12px 0;color:#333;min-height:1em}
  #pair-help{color:#666;font-size:.9em;line-height:1.5}
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
  <div class="pair-section" id="pair-section">
    <h3>🔢 Or link with phone number (no QR)</h3>
    <input id="pair-number" inputmode="numeric" placeholder="10-digit WhatsApp number (or with country code)">
    <button class="btn" onclick="getPairCode()">Get pairing code</button>
    <div id="pair-code"></div>
    <div id="pair-help" class="hidden">On the phone: <strong>WhatsApp → Linked devices → Link a device → Link with phone number instead</strong>, then enter this code.</div>
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
  async function getPairCode(){
    var n=document.getElementById('pair-number').value;
    var out=document.getElementById('pair-code');
    out.textContent='…';
    try{
      var r=await fetch('/pair?number='+encodeURIComponent(n));
      var d=await r.json();
      if(d.code){
        out.textContent=d.code.length===8?d.code.slice(0,4)+'-'+d.code.slice(4):d.code;
        document.getElementById('pair-help').classList.remove('hidden');
      } else { out.textContent=''; out.textContent=d.error||'Failed'; out.style.fontSize='1em'; }
    }catch(e){ out.textContent='Failed — bot unreachable'; out.style.fontSize='1em'; }
  }
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
        document.getElementById('pair-section').classList.add('hidden');
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
      const host = process.env.PUBLIC_HOST || 'localhost';
      log.info(`🌐 HTTP server: http://${host}:${port}`);
      log.info(`📱 Scan page:   http://${host}:${port}/   (shareable)`);
      log.info(`💚 Health:      http://${host}:${port}/health`);
    });
  }

  async function gracefulShutdown(signal) {
    log.info(`👋 ${signal} — shutting down`);
    isShuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    scheduler.stop();
    if (telegram) telegram.stop();
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
  log.info(`   Transport: ${config.transport}`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (config.telegramMissing) {
    log.warn('⚠️  config.json asks for "dual" but TELEGRAM_TOKEN is not set — running WhatsApp-ONLY.');
    log.warn('   There is no backup channel: if this number gets flagged, the sheet becomes');
    log.warn(`   unreachable until the token is added. Fix: create a bot with @BotFather, then`);
    log.warn(`   add TELEGRAM_TOKEN=… to bots/${config.botName}/.env and: pm2 restart ${config.botName}`);
  }

  // Telegram comes up BEFORE the WhatsApp socket, on purpose: linking Baileys can take
  // tens of seconds (or never, on a flagged number), and the whole point of the second
  // channel is that it does not depend on the first.
  if (config.usesTelegram) {
    telegram = createTelegramListener({
      token: config.telegramToken,
      allowedIds: config.allowedTelegramIds,
      bootstrapMode: config.bootstrapMode,
      botName: config.botName,
      profile: config.profile,
      log,
      onCommand: async (text, reply) => {
        // The parser is built as soon as connectToWhatsApp() constructs a socket object,
        // which happens even on a number that will be refused — so this window is the few
        // seconds of auth-load and version-fetch at boot, not the banned state.
        if (!commandParser) {
          return reply('⏳ Still starting up — the WhatsApp socket is initialising. Try again in a few seconds.');
        }
        try {
          await reply(await commandParser.parse(text));
        } catch (err) {
          log.error(`❌ Telegram command failed: ${err.message}`);
          await reply(`❌ ${err.message}`).catch(() => {});
        }
      },
    });
    // A bad token must NOT stop WhatsApp from coming up: group ops are the reason this bot
    // still holds a socket at all, and they are unaffected by anything Telegram does. Same
    // reasoning in reverse for the polling loop below.
    try {
      const me = await telegram.connect();
      log.info(`✅ Telegram: @${me.username} — ${telegram.operatorCount()} operator(s)`);
      if (config.bootstrapMode) {
        log.warn(`🔑 SETUP MODE — message https://t.me/${me.username}, then put the id it replies with`);
        log.warn(`   into "allowedTelegramIds" in bots/${config.botName}/config.json and restart.`);
      }
      telegram.start().catch(err => {
        log.error(`❌ Telegram polling stopped — ${err.message}`);
        log.error('   WhatsApp is unaffected. Fix the token and restart to get the backup channel back.');
      });
    } catch (err) {
      log.error(`❌ Telegram listener did not start — ${err.message}`);
      log.error('   Continuing on WhatsApp alone. There is NO backup channel until this is fixed.');
      telegram = null;
    }
  }

  startHttpServer();
  await connectToWhatsApp();
}
