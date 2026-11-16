import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion, Browsers,
} from '@whiskeysockets/baileys';
import { markLinkedAt, inWarmup } from './warmup.js';
import { createDeliveryTracker } from './deliveryTracker.js';

// Second WhatsApp session, used ONLY by the drip for member DMs (config.dmSession).
//
// Why: one number doing reminders AND group removals is the pattern most likely to get
// flagged. bot-nitin's aged number keeps the DMs (its history is what makes them safe) and
// a separate number takes the group ops on the main session.
//
// Send-only: incoming messages are ignored here — members' replies land on the phone,
// where the operator reads them. Same 401/403 rule as the main socket: halt, never loop a
// re-link. QR (only if it ever needs re-linking) is served at /qr-dm by index.js.
const dmAuthDir = (config) => path.join(config.botDir, config.dmSession.authDir || 'baileys_auth_dm');
export const dmAuthExists = (config) => fs.existsSync(path.join(dmAuthDir(config), 'creds.json'));

export function createDmSocket({ config, log }) {
  const authDir = dmAuthDir(config);
  const warmupHours = config.dmSession.warmupHours ?? 72;
  const tracker = createDeliveryTracker(log);
  let sock = null, latestQR = null, attempts = 0, halted = false, connecting = false;
  let onUpsert = null;   // appIntake: the only reader of incoming DMs here

  async function connect() {
    if (connecting || halted) return;
    connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const fresh = !state.creds?.me;   // QR links never set `registered` in Baileys 7
      const { version } = await fetchLatestBaileysVersion();
      const logger = pino({ level: 'silent' });
      sock = makeWASocket({
        version, logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, syncFullHistory: false, getMessage: async () => undefined,
        defaultQueryTimeoutMs: 60000, connectTimeoutMs: 60000, keepAliveIntervalMs: 30000,
      });
      tracker.attach(sock);
      sock.ev.on('messages.upsert', (u) => onUpsert?.(u));
      sock.ev.on('creds.update', async () => {
        if (fresh && state.creds?.me) markLinkedAt(authDir);
        await saveCreds();
      });
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { latestQR = { qr, at: Date.now() }; log.info('📱 DM session: QR ready at /qr-dm'); }
        if (connection === 'open') { latestQR = null; attempts = 0; log.info('✅ DM session connected'); }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          sock = null;
          if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
            halted = true;
            log.error(`❌ DM session ${code === 403 ? 'FORBIDDEN (403)' : 'LOGGED OUT (401)'} — DM reconnects halted. Do not rescan a flagged number.`);
            return;
          }
          const delay = Math.min(3000 * 2 ** attempts++, 5 * 60 * 1000);
          log.warn(`⚠️  DM session closed (${code}) — reconnecting in ${Math.round(delay / 1000)}s`);
          setTimeout(connect, delay).unref?.();
        }
      });
    } catch (err) {
      log.warn(`⚠️  DM session connect failed: ${err.message}`);
      setTimeout(connect, 60000).unref?.();
    } finally { connecting = false; }
  }

  return {
    connect,
    getSock: () => (sock?.user ? sock : null),
    warmingUp: () => inWarmup(authDir, warmupHours),
    tracker,
    onMessages: (fn) => { onUpsert = fn; },
    qr: () => latestQR,
    close: () => { halted = true; try { sock?.end?.(); } catch { /* closing anyway */ } },
  };
}
