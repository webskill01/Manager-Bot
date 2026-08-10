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

// Transport follows TELEGRAM_TOKEN in this bot's .env — set it and the bot talks to its
// operator over Telegram and never opens a WhatsApp socket; leave it out and nothing
// changes. loadConfig() reads the .env, so this check has to come after it, not before.
// The import is dynamic so a Telegram bot never even loads Baileys.
const { startBot } = config.transport === 'telegram'
  ? await import('../../core/telegram.js')
  : await import('../../core/index.js');

log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log.info(`🟢 ${BOT_NAME} — starting`);
log.info(`   Bot Dir  : ${BOT_DIR}`);
log.info(`   Transport: ${config.transport}`);
if (config.transport === 'whatsapp') log.info(`   Auth Dir : ${AUTH_DIR}`);
log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

await startBot(config, log, AUTH_DIR);
