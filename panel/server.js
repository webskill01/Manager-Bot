// EaseCab recovery panel: `node panel/server.js`, behind nginx at panel.easecab.com.
// Every billing date in the sheets is an IST calendar day, so the process runs on IST
// whatever the VPS clock says.
process.env.TZ = 'Asia/Kolkata';

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadBotConfigs, PANEL_DIR } from './lib/env.js';
import { openDb } from './lib/db.js';
import { createSync } from './lib/sync.js';
import { createRenewer } from './lib/renew.js';
import { createApp } from './routes.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('panel');
const env = loadEnv();
const botCfg = loadBotConfigs(Object.keys(env.sheets));
const db = openDb(env.dbFile);
const sync = createSync({ env, botCfg, db, log });
const renewer = createRenewer({ sync, botCfg, db, log });

const dist = path.join(PANEL_DIR, 'web', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) log.warn('panel/web/dist missing: run `npm run build` in panel/web');

await sync.start();
const app = createApp({ db, sync, botCfg, renewer, env, staticDir: fs.existsSync(dist) ? dist : null });
app.listen(env.port, '127.0.0.1', () => {
  const s = sync.status();
  log.info(`EaseCab panel on 127.0.0.1:${env.port} · ${s.members} people from ${s.bots.join(', ')}`);
});
