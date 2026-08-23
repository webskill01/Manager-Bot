// One-off ledger backfill for bots that are not running.
//
//   node scripts/ledger-backfill.js                    (all four)
//   node scripts/ledger-backfill.js bot-abhi           (just one)
//
// Identical to what the 6 AM cron does — same createLedger, same reconcile — so it can only
// produce what the bot would have produced itself. Safe to re-run: rows that already match
// are not rewritten.
//
// ONE BOT PER PROCESS, and that is not a style choice. loadConfig() copies each bot's .env
// into process.env and refuses to overwrite what is already there (globalConfig.js), so the
// first bot loaded wins SHEET_ID and BOT_NAME for the whole process and every bot after it
// silently reads the FIRST bot's sheet under the first bot's name. Every bot has its own pm2
// process in production, so nothing there ever hits this. A loop in one process does, which
// is why this forks a child per bot instead.

import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig } from '../core/globalConfig.js';
import { createSheetClient } from '../core/sheetClient.js';
import { createMemberStore } from '../core/memberStore.js';
import { createLedger } from '../core/ledger.js';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const ALL = ['bot-nitin', 'bot-abhi', 'bot-sachin2', 'bot-aayush2'];

const log = {
  info: (m) => console.log(`   ${m}`),
  warn: (m) => console.warn(`   ${m}`),
  error: (m) => console.error(`   ${m}`),
};

async function backfill(bot) {
  const config = loadConfig(path.join(ROOT, 'bots', bot));
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId, log);
  const store = createMemberStore(sheetClient, config.botName);
  const ledger = createLedger(config, store, log);
  if (!ledger.enabled) return console.log('   skipped — no ledger configured');
  const r = await ledger.reconcile();
  console.log(`   ✅ ${r.dates} date(s): ${r.appended} added, ${r.updated} corrected`);
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

if (args.length === 1) {
  // No header here — the parent prints one before forking, and a child run by hand reads
  // fine without it.
  await backfill(args[0]).catch(err => { console.error(`   ❌ ${err.message}`); process.exit(1); });
} else {
  let failed = 0;
  for (const bot of (args.length > 0 ? args : ALL)) {
    console.log(`\n📒 ${bot}`);
    const res = spawnSync(process.execPath, [HERE, bot], { stdio: 'inherit' });
    if (res.status !== 0) failed++;
  }
  if (failed > 0) process.exit(1);
}
