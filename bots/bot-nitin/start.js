#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../core/globalConfig.js';
import { createLogger } from '../../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const BOT_DIR = path.dirname(__filename);
const AUTH_DIR = path.join(BOT_DIR, 'baileys_auth');

const BOT_NAME = process.env.BOT_NAME || path.basename(BOT_DIR);
const log = createLogger(BOT_NAME);

const config = loadConfig(BOT_DIR);
config.botDir = BOT_DIR;

// bot-nitin runs "dual" (declared in config.json): core/index.js keeps the WhatsApp socket
// for group ops — add/kick/approve, which the Cloud API can never do — and also starts a
// Telegram listener on the same command parser, so a 403 costs the group commands and
// nothing else. "telegram" would drop the socket entirely; that is the tracker bots' mode.
// loadConfig() reads the .env, so this has to come after it, not before.
const { startBot } = config.transport === 'telegram'
  ? await import('../../core/telegram.js')
  : await import('../../core/index.js');

log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log.info(`🟢 ${BOT_NAME} — starting`);
log.info(`   Bot Dir  : ${BOT_DIR}`);
log.info(`   Transport: ${config.transport}`);
if (config.transport !== 'telegram') log.info(`   Auth Dir : ${AUTH_DIR}`);
log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

await startBot(config, log, AUTH_DIR);
