import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(PANEL_DIR, '..');

// "a=1,b=2" → { a: '1', b: '2' }
const pairs = (s) => Object.fromEntries(String(s || '').split(',')
  .map(p => p.split('=').map(x => x.trim())).filter(([k, v]) => k && v));

// panel/.env is gitignored: the repo is public and these grant access to member data.
// Loud, specific errors at boot beat a panel that starts and shows nobody.
export function loadEnv(file = path.join(PANEL_DIR, '.env'), env = process.env) {
  const vars = { ...env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      const eq = t.indexOf('=');
      if (!t || t.startsWith('#') || eq < 0) continue;
      const k = t.slice(0, eq).trim();
      if (vars[k] === undefined) vars[k] = t.slice(eq + 1).trim();
    }
  }

  const sheets = pairs(vars.PANEL_SHEETS);
  const errors = [];
  if (!Object.keys(sheets).length) errors.push('PANEL_SHEETS=bot-nitin=<sheetId>,bot-abhi=<sheetId>,...');
  for (const bot of Object.keys(sheets)) {
    if (!fs.existsSync(path.join(REPO_DIR, 'bots', bot, 'config.json'))) errors.push(`PANEL_SHEETS names ${bot} but bots/${bot}/config.json is missing`);
  }
  const serviceAccount = path.resolve(PANEL_DIR, vars.SERVICE_ACCOUNT || 'service-account.json');
  if (!fs.existsSync(serviceAccount)) errors.push(`SERVICE_ACCOUNT file not found: ${serviceAccount}`);
  const pin = vars.PANEL_PIN || '';
  if (pin.length < 8) errors.push('PANEL_PIN (admin recovery PIN, 8+ chars)');
  if (errors.length) throw new Error(`panel/.env is incomplete:\n  - ${errors.join('\n  - ')}`);

  return Object.freeze({
    sheets,
    allNumbersSheet: vars.ALL_NUMBERS_SHEET || '',
    serviceAccount,
    appSyncUrl: vars.APP_SYNC_URL || '',
    appSyncToken: vars.APP_SYNC_TOKEN || '',
    port: parseInt(vars.PANEL_PORT || '8110', 10),
    adminName: vars.PANEL_ADMIN_NAME || 'admin',
    pin,
    appPrice: parseInt(vars.PANEL_APP_PRICE || '149', 10),
    dbFile: path.resolve(PANEL_DIR, vars.PANEL_DB || 'panel.db'),
    syncMs: parseInt(vars.PANEL_SYNC_MS || '120000', 10),
  });
}

// Prices and removal day straight from each bot's committed config.json. NOT loadConfig():
// that copies a bot's .env into process.env and the first bot loaded would win SHEET_ID.
export function loadBotConfigs(bots, repoDir = REPO_DIR) {
  return Object.fromEntries(bots.map(bot => {
    const c = JSON.parse(fs.readFileSync(path.join(repoDir, 'bots', bot, 'config.json'), 'utf8'));
    return [bot, {
      botName: bot,
      renewal: c.renewal,
      removalDay: c.overdue?.consolidatedListDays ?? 7,
      profile: c.profile || 'full',
    }];
  }));
}
