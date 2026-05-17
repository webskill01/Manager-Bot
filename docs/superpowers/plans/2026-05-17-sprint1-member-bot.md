# WhatsApp Member Management Bot — Sprint 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live WhatsApp bot on the support number that reads/writes a Google Sheet and responds to all owner commands (add, kick, renewed, find, due, overdue, etc.)

**Architecture:** Baileys connection ported from taxi bot handles WhatsApp. Owner sends private DMs to bot number; commandParser routes to handlers; handlers read/write via sheetClient; groupManager handles all 11-group operations with 10–15s gaps. All settings live in config.json.

**Tech Stack:** Node.js 18+ (ESM), Baileys 6.7+, googleapis, express, pino/pino-pretty, node-cron (wired now, used in Sprint 2), dotenv, PM2

---

## File Map

| File | Status | Purpose |
|---|---|---|
| `package.json` | Create | Dependencies |
| `core/logger.js` | Port from taxi bot | Pino logger with bot prefix |
| `core/globalConfig.js` | Create | Config loader + validator |
| `core/sheetClient.js` | Create | Google Sheets API read/write |
| `core/memberStore.js` | Create | In-memory cache + sheet sync |
| `core/groupManager.js` | Create | Add/remove/approve across 11 groups |
| `core/commandParser.js` | Create | Owner DM router |
| `core/handlers/memberHandlers.js` | Create | add, kick, skip, unskip, approve, links, groupcheck |
| `core/handlers/renewalHandlers.js` | Create | renewed, due, overdue, pending |
| `core/handlers/lookupHandlers.js` | Create | find, status |
| `core/handlers/reportHandlers.js` | Create | summary, stats, revenue, groups, ping, help |
| `core/index.js` | Port + adapt | Baileys connection (owner DM listener) |
| `bots/bot-nitin/start.js` | Port from taxi bot | Entry point |
| `bots/bot-nitin/config.json` | Create | All tweakable settings |
| `bots/bot-nitin/.env` | Create | BOT_NAME, OWNER_NUMBER, SHEET_ID, PORT |
| `scripts/migrate.js` | Create | staging.csv → normalize → write to sheet |
| `ecosystem.config.cjs` | Port + adapt | PM2 manifest |

---

## Task 0: Manual — Google Cloud + Google Sheet Setup

> Do this before writing any code. No code in this task.

- [ ] Go to https://console.cloud.google.com → Create new project → name it `member-mgmt-bot`
- [ ] In the project: APIs & Services → Library → search "Google Sheets API" → Enable
- [ ] APIs & Services → Credentials → Create Credentials → Service Account
  - Name: `member-bot-sheets`
  - Role: Editor
  - Done → click the service account → Keys → Add Key → JSON → Download
- [ ] Save the downloaded JSON key as `bots/bot-nitin/service-account.json`
- [ ] Create a new Google Sheet → name it anything → copy the Sheet ID from the URL
  - URL format: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`
- [ ] Rename Sheet1 tab to `MEMBERS`
- [ ] Add header row to MEMBERS (Row 1):
  ```
  NAME | PHONE | JOIN_DATE | BILLING_DATE | STATUS | RENEWALS | PAID_LAST | REFERENCE | SKIP_REASON | ADDED_BY | LAST_UPDATED
  ```
- [ ] Share the Google Sheet with the service account email (found in the JSON key as `client_email`) → Editor access
- [ ] Note the SHEET_ID — you'll put it in `.env`

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `logs/.gitkeep`

- [ ] **Create folder structure**

```bash
mkdir -p core/handlers bots/bot-nitin/baileys_auth logs scripts docs/superpowers/specs docs/superpowers/plans
```

- [ ] **Create `package.json`**

```json
{
  "name": "member-mgmt-bot",
  "version": "1.0.0",
  "description": "WhatsApp subscription group manager",
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "start:nitin": "node bots/bot-nitin/start.js",
    "migrate": "node scripts/migrate.js",
    "pm2:start": "pm2 start ecosystem.config.cjs",
    "pm2:stop": "pm2 stop all",
    "pm2:logs": "pm2 logs",
    "pm2:status": "pm2 status"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.9",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "googleapis": "^144.0.0",
    "node-cron": "^3.0.3",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "qrcode": "^1.5.4",
    "qrcode-terminal": "^0.12.0"
  },
  "devDependencies": {
    "pm2": "^5.4.2"
  }
}
```

- [ ] **Create `.gitignore`**

```
node_modules/
bots/*/baileys_auth/
bots/*/.env
bots/*/service-account.json
logs/*.log
*.log
```

- [ ] **Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Commit**

```bash
git init
git add package.json .gitignore logs/.gitkeep
git commit -m "feat: initial project scaffold"
```

---

## Task 2: logger.js (Port from Taxi Bot)

**Files:**
- Create: `core/logger.js`

- [ ] **Create `core/logger.js`** — port directly from taxi bot, no changes needed

```javascript
import pino from 'pino';

const transport = pino.transport({
  target: 'pino-pretty',
  options: { translateTime: true, colorize: true },
});

export function createLogger(botId) {
  const prefix = `[${botId}]`;
  const pinoInstance = pino({ level: 'info' }, transport);
  return {
    info: (...args) => pinoInstance.info(`${prefix} ${args[0]}`, ...args.slice(1)),
    warn: (...args) => pinoInstance.warn(`${prefix} ${args[0]}`, ...args.slice(1)),
    error: (...args) => pinoInstance.error(`${prefix} ${args[0]}`, ...args.slice(1)),
  };
}

export function panic(err, context = 'fatal-error') {
  console.error(`[PANIC] ${context} —`, err);
  process.exit(1);
}
```

- [ ] **Smoke test logger**

```bash
node -e "
import('./core/logger.js').then(({ createLogger }) => {
  const log = createLogger('test');
  log.info('Logger working');
  log.warn('Warning test');
  process.exit(0);
});
"
```

Expected: `[test] Logger working` printed in color with timestamp.

- [ ] **Commit**

```bash
git add core/logger.js
git commit -m "feat: add pino logger (port from taxi bot)"
```

---

## Task 3: globalConfig.js (Config Loader)

**Files:**
- Create: `core/globalConfig.js`
- Create: `bots/bot-nitin/config.json`
- Create: `bots/bot-nitin/.env`

- [ ] **Create `bots/bot-nitin/.env`** (fill in real values)

```
BOT_NAME=bot-nitin
OWNER_NUMBER=919XXXXXXXXX
SHEET_ID=your_google_sheet_id_here
STATS_PORT=3010
```

- [ ] **Create `bots/bot-nitin/config.json`** (fill in real group JIDs)

```json
{
  "botName": "bot-nitin",
  "paidGroups": [
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us",
    "120363XXXXX@g.us"
  ],
  "upiQrPath": "./qr-payment.jpg",
  "renewal": {
    "fullAmount": 90,
    "referralAmount": 45,
    "billingCycleDays": 30
  },
  "joining": {
    "fee": 90
  },
  "overdue": {
    "autoReminderDays": 6,
    "consolidatedListDays": 7
  },
  "rateLimits": {
    "memberToMemberGapMinMs": 10000,
    "memberToMemberGapMaxMs": 15000,
    "groupOpGapMinMs": 10000,
    "groupOpGapMaxMs": 15000,
    "batchSize": 20,
    "secondBatchDelayMs": 7200000,
    "circuitBreakerThreshold": 10,
    "circuitBreakerCooldownMs": 60000
  },
  "schedule": {
    "morningDigest": "0 9 * * *",
    "reminderSend": "30 9 * * *",
    "eveningSummary": "0 22 * * *",
    "timezone": "Asia/Kolkata"
  },
  "messages": {
    "reminder": "Sat Sri Akal {name} ji 🙏\n\nAapki group membership aaj renew honi hai.\nPlease ₹90 is QR code se bhejo aur screenshot share karo.\n\nShukriya! 🚕",
    "overdue": "Sat Sri Akal {name} ji 🙏\n\nAapki membership {days} din se overdue hai.\nPlease jaldi renew karo warna group se remove karna padega.\n\n₹90 bhejo aur screenshot share karo. 🙏",
    "overdueConsolidated": "📋 OVERDUE MEMBERS ({count}):\n\n{list}\n\nReply: R[n]=Remove, S[n]=Skip, W[n]=Warn\nExample: R1 R2 S3"
  }
}
```

- [ ] **Create `core/globalConfig.js`**

```javascript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function loadConfig(botDir) {
  // Load .env
  const envPath = path.join(botDir, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }

  // Load config.json
  const configPath = path.join(botDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Inject env values
  config.ownerNumber = process.env.OWNER_NUMBER || '';
  config.sheetId = process.env.SHEET_ID || '';
  config.botName = process.env.BOT_NAME || config.botName;
  config.statsPort = parseInt(process.env.STATS_PORT || '3010', 10);
  config.serviceAccountPath = path.join(botDir, 'service-account.json');
  config.botDir = botDir;

  // Validate required fields
  const required = ['ownerNumber', 'sheetId', 'paidGroups'];
  for (const field of required) {
    if (!config[field] || (Array.isArray(config[field]) && config[field].length === 0)) {
      throw new Error(`Config missing required field: ${field}`);
    }
  }

  if (config.paidGroups.length !== 11) {
    console.warn(`⚠️  Expected 11 paidGroups, got ${config.paidGroups.length}`);
  }

  if (!fs.existsSync(config.serviceAccountPath)) {
    throw new Error(`service-account.json not found at ${config.serviceAccountPath}`);
  }

  return config;
}

// Utility: random int between min and max (inclusive)
export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Utility: sleep for ms
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility: normalize phone to 10 digits
export function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.slice(-10);
}

// Utility: format date as DD-MM-YYYY
export function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Utility: parse DD-MM-YYYY to Date
export function parseDate(str) {
  if (!str || !str.includes('-')) return null;
  const parts = str.split('-');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map(Number);
  return new Date(year, month - 1, day);
}

// Utility: days from today (negative = past)
export function daysFromToday(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (1000 * 60 * 60 * 24));
}

// Utility: today as DD-MM-YYYY
export function todayStr() {
  return formatDate(new Date());
}
```

- [ ] **Smoke test config loader**

```bash
node -e "
import('./core/globalConfig.js').then(({ loadConfig }) => {
  const config = loadConfig('./bots/bot-nitin');
  console.log('botName:', config.botName);
  console.log('groups:', config.paidGroups.length);
  console.log('ownerNumber:', config.ownerNumber ? 'SET' : 'MISSING');
  console.log('sheetId:', config.sheetId ? 'SET' : 'MISSING');
  process.exit(0);
});
"
```

Expected: `botName: bot-nitin`, `groups: 11`, `ownerNumber: SET`, `sheetId: SET`

- [ ] **Commit**

```bash
git add core/globalConfig.js bots/bot-nitin/config.json
git commit -m "feat: config loader with validation and phone normalization utilities"
```

---

## Task 4: sheetClient.js (Google Sheets API)

**Files:**
- Create: `core/sheetClient.js`

The sheet has columns in order: NAME, PHONE, JOIN_DATE, BILLING_DATE, STATUS, RENEWALS, PAID_LAST, REFERENCE, SKIP_REASON, ADDED_BY, LAST_UPDATED (columns A–K, rows start at 2).

- [ ] **Create `core/sheetClient.js`**

```javascript
import { google } from 'googleapis';

const SHEET_NAME = 'MEMBERS';
const DATA_RANGE = `${SHEET_NAME}!A2:K`;
const COLUMNS = ['NAME', 'PHONE', 'JOIN_DATE', 'BILLING_DATE', 'STATUS',
  'RENEWALS', 'PAID_LAST', 'REFERENCE', 'SKIP_REASON', 'ADDED_BY', 'LAST_UPDATED'];

function rowToMember(row, rowIndex) {
  return {
    rowIndex, // 1-based row number in the sheet (row 2 = index 2)
    name: row[0] || '',
    phone: row[1] || '',
    joinDate: row[2] || '',
    billingDate: row[3] || '',
    status: row[4] || 'ACTIVE',
    renewals: parseInt(row[5] || '0', 10),
    paidLast: parseInt(row[6] || '0', 10),
    reference: row[7] || '',
    skipReason: row[8] || '',
    addedBy: row[9] || '',
    lastUpdated: row[10] || '',
  };
}

function memberToRow(member) {
  return [
    member.name,
    member.phone,
    member.joinDate,
    member.billingDate,
    member.status,
    String(member.renewals),
    String(member.paidLast),
    member.reference || '',
    member.skipReason || '',
    member.addedBy || '',
    new Date().toISOString(),
  ];
}

export async function createSheetClient(serviceAccountPath, spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  async function getAll() {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: DATA_RANGE,
    });
    const rows = res.data.values || [];
    return rows.map((row, i) => rowToMember(row, i + 2)); // row 2 is index 2
  }

  async function appendRow(member) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:K`,
      valueInputOption: 'RAW',
      requestBody: { values: [memberToRow(member)] },
    });
  }

  async function updateRow(rowIndex, member) {
    const range = `${SHEET_NAME}!A${rowIndex}:K${rowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [memberToRow(member)] },
    });
  }

  return { getAll, appendRow, updateRow };
}
```

- [ ] **Smoke test Google Sheets connection**

```bash
node -e "
import('./core/globalConfig.js').then(async ({ loadConfig }) => {
  const config = loadConfig('./bots/bot-nitin');
  const { createSheetClient } = await import('./core/sheetClient.js');
  const client = await createSheetClient(config.serviceAccountPath, config.sheetId);
  const rows = await client.getAll();
  console.log('Connected. Rows in sheet:', rows.length);
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected: `Connected. Rows in sheet: 0` (empty sheet before migration)

- [ ] **Commit**

```bash
git add core/sheetClient.js
git commit -m "feat: Google Sheets API client with read/write/update"
```

---

## Task 5: memberStore.js (In-Memory Cache)

**Files:**
- Create: `core/memberStore.js`

MemberStore wraps sheetClient with an in-memory cache. All handlers read from cache; writes go to cache AND sheet immediately.

- [ ] **Create `core/memberStore.js`**

```javascript
import { normalizePhone } from './globalConfig.js';

export function createMemberStore(sheetClient, botName) {
  let members = []; // in-memory cache

  async function refresh() {
    members = await sheetClient.getAll();
  }

  function findByPhone(phone) {
    const normalized = normalizePhone(phone);
    return members.find(m => normalizePhone(m.phone) === normalized) || null;
  }

  function findByName(name) {
    const lower = name.toLowerCase();
    return members.filter(m => m.name.toLowerCase().includes(lower));
  }

  function getAll() {
    return [...members];
  }

  function getActive() {
    return members.filter(m => m.status === 'ACTIVE');
  }

  async function add(memberData) {
    const member = {
      ...memberData,
      status: 'ACTIVE',
      renewals: 0,
      paidLast: memberData.paidLast || 90,
      reference: memberData.reference || '',
      skipReason: '',
      addedBy: botName,
      lastUpdated: new Date().toISOString(),
    };
    await sheetClient.appendRow(member);
    await refresh(); // sync cache after write
    return findByPhone(member.phone);
  }

  async function update(phone, updates) {
    const member = findByPhone(phone);
    if (!member) throw new Error(`Member not found: ${phone}`);
    const updated = { ...member, ...updates, lastUpdated: new Date().toISOString() };
    await sheetClient.updateRow(member.rowIndex, updated);
    await refresh();
    return findByPhone(phone);
  }

  async function initialize() {
    await refresh();
  }

  return { initialize, refresh, findByPhone, findByName, getAll, getActive, add, update };
}
```

- [ ] **Commit**

```bash
git add core/memberStore.js
git commit -m "feat: member store with in-memory cache and sheet sync"
```

---

## Task 6: scripts/migrate.js (Data Migration)

**Files:**
- Create: `scripts/migrate.js`
- Create: `scripts/staging.csv` (you fill this in)

Migration script reads your manually curated CSV of active members and writes them to the new sheet.

- [ ] **Create `scripts/staging.csv` template** (you fill in your actual data)

```csv
NAME,PHONE,JOIN_DATE,BILLING_DATE
Harpreet Singh,9855100001,01-01-2026,01-06-2026
Rajesh Kumar,9779100002,15-02-2026,15-06-2026
```

CSV rules:
- PHONE: any format (10 digits, with 91, with +91, with 0) — script normalizes
- JOIN_DATE and BILLING_DATE: DD-MM-YYYY format

- [ ] **Create `scripts/migrate.js`**

```javascript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, normalizePhone, formatDate, parseDate } from '../core/globalConfig.js';
import { createSheetClient } from '../core/sheetClient.js';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const BOT_DIR = path.join(SCRIPT_DIR, '../bots/bot-nitin');
const STAGING_CSV = path.join(SCRIPT_DIR, 'staging.csv');

function parseCSV(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  return lines.slice(1).map((line, i) => {
    const values = line.split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j] || ''; });
    row._lineNumber = i + 2;
    return row;
  });
}

function validateRow(row) {
  const errors = [];
  const phone = normalizePhone(row.PHONE || '');
  if (phone.length !== 10) errors.push(`Invalid phone: "${row.PHONE}"`);
  if (!row.NAME || row.NAME.length < 2) errors.push(`Missing/short name: "${row.NAME}"`);
  if (!row.JOIN_DATE || !parseDate(row.JOIN_DATE)) errors.push(`Invalid JOIN_DATE: "${row.JOIN_DATE}" (use DD-MM-YYYY)`);
  if (!row.BILLING_DATE || !parseDate(row.BILLING_DATE)) errors.push(`Invalid BILLING_DATE: "${row.BILLING_DATE}" (use DD-MM-YYYY)`);
  return errors;
}

async function migrate() {
  console.log('📊 Migration starting...\n');

  if (!fs.existsSync(STAGING_CSV)) {
    console.error(`❌ staging.csv not found at ${STAGING_CSV}`);
    process.exit(1);
  }

  const config = loadConfig(BOT_DIR);
  const client = await createSheetClient(config.serviceAccountPath, config.sheetId);
  const rows = parseCSV(fs.readFileSync(STAGING_CSV, 'utf8'));

  console.log(`📥 Parsed ${rows.length} rows from staging.csv\n`);

  // Validate all rows first — abort on any error
  let hasErrors = false;
  const phones = new Set();
  for (const row of rows) {
    const errors = validateRow(row);
    const phone = normalizePhone(row.PHONE || '');
    if (phones.has(phone)) errors.push(`Duplicate phone: ${phone}`);
    phones.add(phone);
    if (errors.length > 0) {
      console.error(`❌ Row ${row._lineNumber} (${row.NAME}): ${errors.join(', ')}`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('\n❌ Validation failed. Fix errors above before migrating.');
    process.exit(1);
  }

  console.log('✅ Validation passed. Writing to sheet...\n');

  // Write rows one by one
  let written = 0;
  for (const row of rows) {
    const member = {
      name: row.NAME,
      phone: normalizePhone(row.PHONE),
      joinDate: row.JOIN_DATE,
      billingDate: row.BILLING_DATE,
      status: 'ACTIVE',
      renewals: 0,
      paidLast: 90,
      reference: row.REFERENCE || '',
      skipReason: '',
      addedBy: 'migration',
      lastUpdated: new Date().toISOString(),
    };
    await client.appendRow(member);
    written++;
    process.stdout.write(`\r   Written: ${written}/${rows.length}`);
    // Small delay to avoid Sheets API rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n✅ Migration complete — ${written} members written to sheet.`);
  console.log('   Open your Google Sheet to verify the data.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
```

- [ ] **Dry-run validation (before filling real data)**

```bash
node scripts/migrate.js
```

Expected: Error saying `staging.csv not found` OR validation errors if CSV has bad data. Both are correct — the script should not write anything until all rows are valid.

- [ ] **Fill staging.csv with your real active members, then run migration**

```bash
node scripts/migrate.js
```

Expected: `✅ Migration complete — N members written to sheet.`

- [ ] **Verify in Google Sheet** — open browser, check MEMBERS tab has all rows with correct data.

- [ ] **Commit**

```bash
git add scripts/migrate.js scripts/staging.csv
git commit -m "feat: migration script with validation, phone normalization, duplicate check"
```

---

## Task 7: groupManager.js (Group Operations)

**Files:**
- Create: `core/groupManager.js`

groupManager wraps Baileys group operations with rate-limiting gaps from config.

- [ ] **Create `core/groupManager.js`**

```javascript
import { randomBetween, sleep, normalizePhone } from './globalConfig.js';

export function createGroupManager(sock, config, log) {
  const { paidGroups, rateLimits } = config;

  async function gapBetweenOps() {
    const ms = randomBetween(rateLimits.groupOpGapMinMs, rateLimits.groupOpGapMaxMs);
    log.info(`⏳ Group op gap: ${(ms / 1000).toFixed(1)}s`);
    await sleep(ms);
  }

  // Convert 10-digit phone to WhatsApp JID
  function toJid(phone) {
    const digits = normalizePhone(phone);
    return `91${digits}@s.whatsapp.net`;
  }

  // Add member to all 11 groups. Returns { added: [], failed: [] }
  async function addToAllGroups(phone, name) {
    const jid = toJid(phone);
    const added = [];
    const failed = [];

    log.info(`👤 Adding ${name} (${phone}) to ${paidGroups.length} groups...`);

    for (const groupId of paidGroups) {
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'add');
        added.push(groupId);
        log.info(`✅ Added to ${groupId}`);
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Failed ${groupId}: ${err.message}`);
      }
      if (paidGroups.indexOf(groupId) < paidGroups.length - 1) {
        await gapBetweenOps();
      }
    }

    return { added, failed };
  }

  // Remove member from all groups. Returns { removed: [], failed: [] }
  async function removeFromAllGroups(phone) {
    const jid = toJid(phone);
    const removed = [];
    const failed = [];

    log.info(`🚫 Removing ${phone} from ${paidGroups.length} groups...`);

    for (const groupId of paidGroups) {
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
        removed.push(groupId);
        log.info(`✅ Removed from ${groupId}`);
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Failed ${groupId}: ${err.message}`);
      }
      if (paidGroups.indexOf(groupId) < paidGroups.length - 1) {
        await gapBetweenOps();
      }
    }

    return { removed, failed };
  }

  // Approve pending join requests across all groups
  async function approvePendingRequests(phone) {
    const jid = toJid(phone);
    const approved = [];
    const failed = [];

    for (const groupId of paidGroups) {
      try {
        // Fetch pending participants
        const metadata = await sock.groupMetadata(groupId);
        const pending = metadata.participants?.filter(p =>
          p.jid === jid && p.pending === true
        );
        if (pending && pending.length > 0) {
          await sock.groupRequestParticipantsUpdate(groupId, [jid], 'approve');
          approved.push(groupId);
          log.info(`✅ Approved in ${groupId}`);
        }
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Approve failed ${groupId}: ${err.message}`);
      }
      if (paidGroups.indexOf(groupId) < paidGroups.length - 1) {
        await gapBetweenOps();
      }
    }

    return { approved, failed };
  }

  // Get invite links for groups where member is missing
  async function getInviteLinksForMissing(phone) {
    const jid = toJid(phone);
    const links = [];

    for (const groupId of paidGroups) {
      try {
        const metadata = await sock.groupMetadata(groupId);
        const isMember = metadata.participants?.some(p => p.jid === jid);
        if (!isMember) {
          const inviteCode = await sock.groupInviteCode(groupId);
          links.push({
            groupId,
            groupName: metadata.subject || groupId,
            link: `https://chat.whatsapp.com/${inviteCode}`,
          });
        }
      } catch (err) {
        log.warn(`❌ Invite link failed ${groupId}: ${err.message}`);
      }
    }

    return links;
  }

  // Check which groups a member is in
  async function checkMembership(phone) {
    const jid = toJid(phone);
    const inGroups = [];
    const notInGroups = [];

    for (const groupId of paidGroups) {
      try {
        const metadata = await sock.groupMetadata(groupId);
        const isMember = metadata.participants?.some(p => p.jid === jid);
        const groupName = metadata.subject || groupId;
        if (isMember) {
          inGroups.push(groupName);
        } else {
          notInGroups.push(groupName);
        }
      } catch (err) {
        log.warn(`❌ Membership check failed ${groupId}: ${err.message}`);
      }
    }

    return { inGroups, notInGroups };
  }

  return { addToAllGroups, removeFromAllGroups, approvePendingRequests, getInviteLinksForMissing, checkMembership };
}
```

- [ ] **Commit**

```bash
git add core/groupManager.js
git commit -m "feat: group manager with add/remove/approve/links/check, 10-15s gaps"
```

---

## Task 8: Command Handlers — Member Operations

**Files:**
- Create: `core/handlers/memberHandlers.js`

- [ ] **Create `core/handlers/memberHandlers.js`**

```javascript
import { normalizePhone, formatDate, todayStr } from '../globalConfig.js';

export function createMemberHandlers(store, groupManager, config, log) {

  async function handleAdd(args) {
    // Format: add [phone] [name...]
    if (args.length < 2) return '❌ Missing arguments. Format: add [phone] [name]';
    const rawPhone = args[0];
    const phone = normalizePhone(rawPhone);
    if (phone.length !== 10) return `❌ Invalid number. Use 10 digits: add 98551XXXXX Name`;
    const name = args.slice(1).join(' ').trim();
    if (name.length < 2) return '❌ Name too short. Format: add [phone] [name]';

    const existing = store.findByPhone(phone);
    if (existing && existing.status === 'ACTIVE') {
      return `⚠️ ${existing.name} (${phone}) already ACTIVE. Use 'renewed' to update billing.`;
    }

    // If previously removed, reactivate
    if (existing && existing.status === 'REMOVED') {
      const billingDate = formatDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      await store.update(phone, {
        status: 'ACTIVE',
        billingDate,
        joinDate: todayStr(),
        paidLast: config.joining.fee,
        skipReason: '',
      });
      log.info(`♻️  Reactivated ${name} (${phone})`);
    } else {
      // New member
      const billingDate = formatDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      await store.add({
        name,
        phone,
        joinDate: todayStr(),
        billingDate,
        paidLast: config.joining.fee,
      });
    }

    // Attempt group adds
    const { added, failed } = await groupManager.addToAllGroups(phone, name);
    let reply = `✅ Added ${name} to ${added.length}/${config.paidGroups.length} groups`;
    if (failed.length > 0) {
      const failedNames = failed.map(f => `   • ${f.groupId}`).join('\n');
      reply += `\n❌ Failed ${failed.length} groups (privacy restricted):\n${failedNames}`;
      reply += `\n\nReply: links ${phone}  (to get invite links for failed groups)`;
    }
    return reply;
  }

  async function handleKick(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: kick [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: kick 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status === 'REMOVED') return '⚠️ Already marked REMOVED. Not in any groups.';

    const { removed, failed } = await groupManager.removeFromAllGroups(phone);
    await store.update(phone, { status: 'REMOVED' });

    let reply = `✅ Removed ${member.name} from ${removed.length}/${config.paidGroups.length} groups`;
    if (failed.length > 0) {
      reply += `\n⚠️ Failed ${failed.length} groups — removed from sheet anyway.`;
    }
    return reply;
  }

  async function handleSkip(args) {
    if (args.length < 2) return '❌ Missing arguments. Format: skip [phone] [reason]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: skip 98551XXXXX reason';
    const reason = args.slice(1).join(' ');

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    await store.update(phone, { status: 'SKIPPED', skipReason: reason });
    return `✅ ${member.name} marked SKIPPED — won't appear in auto-remove list.\nReason: ${reason}`;
  }

  async function handleUnskip(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: unskip [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: unskip 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;
    if (member.status !== 'SKIPPED') return `⚠️ ${member.name} is ${member.status}, not SKIPPED.`;

    await store.update(phone, { status: 'ACTIVE', skipReason: '' });
    return `✅ ${member.name} reverted to ACTIVE.`;
  }

  async function handleApprove(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: approve [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const { approved, failed } = await groupManager.approvePendingRequests(phone);
    if (approved.length === 0) return `⚠️ No pending requests found for ${member.name}.`;
    return `✅ Approved ${member.name} in ${approved.length} group(s).`;
  }

  async function handleLinks(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: links [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const links = await groupManager.getInviteLinksForMissing(phone);
    if (links.length === 0) return `✅ ${member.name} is in all ${config.paidGroups.length} groups.`;

    const linkLines = links.map(l => `• ${l.groupName}\n  ${l.link}`).join('\n\n');
    return `🔗 Invite links for ${member.name} (missing from ${links.length} groups):\n\n${linkLines}`;
  }

  async function handleGroupCheck(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: groupcheck [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const { inGroups, notInGroups } = await groupManager.checkMembership(phone);
    let reply = `📋 ${member.name} (${phone}) group membership:\n`;
    reply += `✅ In ${inGroups.length} groups:\n${inGroups.map(g => `   • ${g}`).join('\n')}`;
    if (notInGroups.length > 0) {
      reply += `\n❌ Missing from ${notInGroups.length} groups:\n${notInGroups.map(g => `   • ${g}`).join('\n')}`;
    }
    return reply;
  }

  return { handleAdd, handleKick, handleSkip, handleUnskip, handleApprove, handleLinks, handleGroupCheck };
}
```

- [ ] **Commit**

```bash
git add core/handlers/memberHandlers.js
git commit -m "feat: member command handlers (add, kick, skip, unskip, approve, links, groupcheck)"
```

---

## Task 9: Command Handlers — Renewal & Lookup

**Files:**
- Create: `core/handlers/renewalHandlers.js`
- Create: `core/handlers/lookupHandlers.js`

- [ ] **Create `core/handlers/renewalHandlers.js`**

```javascript
import { normalizePhone, formatDate, daysFromToday, todayStr } from '../globalConfig.js';

export function createRenewalHandlers(store, config, log) {

  async function handleRenewed(args) {
    // Format: renewed [phone] OR renewed [phone] 45
    if (args.length < 1) return '❌ Missing arguments. Format: renewed [phone] OR renewed [phone] 45';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number. Use 10 digits: renewed 98551XXXXX';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}. Try: find [name]`;

    const amount = args[1] === '45' ? config.renewal.referralAmount : config.renewal.fullAmount;
    const newBillingDate = formatDate(
      new Date(Date.now() + config.renewal.billingCycleDays * 24 * 60 * 60 * 1000)
    );

    await store.update(phone, {
      status: 'ACTIVE',
      billingDate: newBillingDate,
      renewals: member.renewals + 1,
      paidLast: amount,
    });

    const type = amount === config.renewal.fullAmount ? 'full' : 'referral';
    return `✅ ${member.name} renewed @ ₹${amount} (${type})\n📅 Next billing: ${newBillingDate}\n🔄 Total renewals: ${member.renewals + 1}`;
  }

  function handleDue(args) {
    const tomorrow = args[0] === 'tomorrow';
    const targetDays = tomorrow ? 1 : 0;
    const label = tomorrow ? 'tomorrow' : 'today';

    const active = store.getActive();
    const due = active.filter(m => daysFromToday(m.billingDate) === targetDays);

    if (due.length === 0) return `📅 No members due ${label}.`;

    const lines = due.map(m => `• ${m.name} • ${m.phone}`).join('\n');
    return `📅 Due ${label} (${due.length}):\n\n${lines}`;
  }

  function handleOverdue() {
    const active = store.getActive();
    const overdue = active
      .filter(m => {
        const days = daysFromToday(m.billingDate);
        return days !== null && days < 0;
      })
      .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    if (overdue.length === 0) return '✅ No overdue members.';

    const lines = overdue.map(m =>
      `[${overdue.indexOf(m) + 1}] ${m.name} • ${m.phone} • ${m.daysOverdue} days overdue`
    ).join('\n');

    return `⚠️ OVERDUE MEMBERS (${overdue.length}):\n\n${lines}\n\nReply: R[n]=Remove, S[n]=Skip, W[n]=Warn\nExample: R1 R2 S3`;
  }

  function handlePending() {
    const active = store.getActive();
    const pending = active.filter(m => {
      const days = daysFromToday(m.billingDate);
      return days !== null && days <= 0;
    });

    if (pending.length === 0) return '✅ No pending renewals.';

    const lines = pending.map(m => {
      const days = Math.abs(daysFromToday(m.billingDate));
      const label = days === 0 ? 'due today' : `${days}d overdue`;
      return `• ${m.name} • ${m.phone} • ${label}`;
    }).join('\n');

    return `⏳ PENDING RENEWALS (${pending.length}):\n\n${lines}`;
  }

  return { handleRenewed, handleDue, handleOverdue, handlePending };
}
```

- [ ] **Create `core/handlers/lookupHandlers.js`**

```javascript
import { normalizePhone, daysFromToday } from '../globalConfig.js';

export function createLookupHandlers(store, config, log) {

  function handleFind(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: find [phone or name]';
    const query = args.join(' ').trim();

    // Try phone first
    const byPhone = store.findByPhone(query);
    if (byPhone) return formatMemberDetail(byPhone);

    // Try name (partial, case-insensitive)
    const byName = store.findByName(query);
    if (byName.length === 0) return `❌ No member found for "${query}".`;
    if (byName.length === 1) return formatMemberDetail(byName[0]);

    // Multiple matches
    const lines = byName.map(m => `• ${m.name} • ${m.phone} • ${m.status}`).join('\n');
    return `🔍 Found ${byName.length} matches for "${query}":\n\n${lines}\n\nUse find [phone] for full details.`;
  }

  function handleStatus(args) {
    if (args.length < 1) return '❌ Missing arguments. Format: status [phone]';
    const phone = normalizePhone(args[0]);
    if (phone.length !== 10) return '❌ Invalid number.';

    const member = store.findByPhone(phone);
    if (!member) return `❌ No member found for ${args[0]}.`;

    const days = daysFromToday(member.billingDate);
    let daysLabel = '';
    if (days === null) daysLabel = 'no billing date';
    else if (days === 0) daysLabel = 'due TODAY';
    else if (days > 0) daysLabel = `due in ${days} days (${member.billingDate})`;
    else daysLabel = `${Math.abs(days)} days OVERDUE`;

    return `📋 ${member.name} (${phone})\nStatus: ${member.status}\nBilling: ${daysLabel}\nRenewals: ${member.renewals} | Last paid: ₹${member.paidLast}`;
  }

  function formatMemberDetail(m) {
    const days = daysFromToday(m.billingDate);
    const daysLabel = days === null ? 'unknown' : days >= 0 ? `${days}d remaining` : `${Math.abs(days)}d OVERDUE`;
    return [
      `👤 ${m.name}`,
      `📱 ${m.phone}`,
      `📊 Status: ${m.status}`,
      `📅 Billing: ${m.billingDate} (${daysLabel})`,
      `🗓️ Joined: ${m.joinDate}`,
      `🔄 Renewals: ${m.renewals} | Last: ₹${m.paidLast}`,
      m.reference ? `👥 Referred by: ${m.reference}` : '',
      m.skipReason ? `⏭️ Skip reason: ${m.skipReason}` : '',
    ].filter(Boolean).join('\n');
  }

  return { handleFind, handleStatus };
}
```

- [ ] **Commit**

```bash
git add core/handlers/renewalHandlers.js core/handlers/lookupHandlers.js
git commit -m "feat: renewal handlers (renewed, due, overdue, pending) and lookup handlers (find, status)"
```

---

## Task 10: Command Handlers — Reports

**Files:**
- Create: `core/handlers/reportHandlers.js`

- [ ] **Create `core/handlers/reportHandlers.js`**

```javascript
import { daysFromToday, todayStr } from '../globalConfig.js';

export function createReportHandlers(store, config, botStartTime, log) {

  function handleSummary(args) {
    const all = store.getAll();
    const today = todayStr();

    const newToday = all.filter(m => m.joinDate === today);
    const renewedToday = all.filter(m => m.lastUpdated?.startsWith(new Date().toISOString().slice(0, 10)) && m.renewals > 0 && m.joinDate !== today);
    const removedToday = all.filter(m => m.status === 'REMOVED' && m.lastUpdated?.startsWith(new Date().toISOString().slice(0, 10)));
    const overdue = all.filter(m => m.status === 'ACTIVE' && daysFromToday(m.billingDate) !== null && daysFromToday(m.billingDate) < -5);
    const totalActive = all.filter(m => m.status === 'ACTIVE').length;

    // Revenue
    const joinRevenue = newToday.length * config.joining.fee;
    const fullRenewals = renewedToday.filter(m => m.paidLast === config.renewal.fullAmount);
    const referralRenewals = renewedToday.filter(m => m.paidLast === config.renewal.referralAmount);
    const renewalRevenue = fullRenewals.length * config.renewal.fullAmount + referralRenewals.length * config.renewal.referralAmount;
    const totalRevenue = joinRevenue + renewalRevenue;

    const dateStr = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    let msg = `📊 Daily Summary — ${dateStr}\n\n`;

    if (newToday.length > 0) {
      msg += `➕ New Members: ${newToday.length} (₹${joinRevenue})\n`;
      msg += newToday.map(m => `   • ${m.name} • ${m.phone}`).join('\n') + '\n\n';
    } else {
      msg += `➕ New Members: 0\n\n`;
    }

    if (renewedToday.length > 0) {
      msg += `♻️ Renewals: ${renewedToday.length}\n`;
      if (fullRenewals.length > 0) msg += `   • ${fullRenewals.length} full @ ₹${config.renewal.fullAmount} = ₹${fullRenewals.length * config.renewal.fullAmount}\n`;
      if (referralRenewals.length > 0) msg += `   • ${referralRenewals.length} referral @ ₹${config.renewal.referralAmount} = ₹${referralRenewals.length * config.renewal.referralAmount}\n`;
      msg += '\n';
    } else {
      msg += `♻️ Renewals: 0\n\n`;
    }

    msg += `💰 Today's Revenue: ₹${totalRevenue}\n`;
    if (joinRevenue > 0 || renewalRevenue > 0) {
      msg += `   (Joins ₹${joinRevenue} + Renewals ₹${renewalRevenue})\n\n`;
    }

    msg += `❌ Removals: ${removedToday.length}\n`;
    msg += `⚠️ Overdue (6+ days): ${overdue.length}\n`;
    msg += `👥 Total Active: ${totalActive}`;

    return msg;
  }

  function handleStats() {
    const all = store.getAll();
    const active = all.filter(m => m.status === 'ACTIVE').length;
    const removed = all.filter(m => m.status === 'REMOVED').length;
    const skipped = all.filter(m => m.status === 'SKIPPED').length;
    const overdue = all.filter(m => m.status === 'ACTIVE' && daysFromToday(m.billingDate) !== null && daysFromToday(m.billingDate) < 0).length;
    const dueToday = all.filter(m => m.status === 'ACTIVE' && daysFromToday(m.billingDate) === 0).length;

    return `📊 STATS\n\n👥 Active: ${active}\n❌ Removed: ${removed}\n⏭️ Skipped: ${skipped}\n⚠️ Overdue: ${overdue}\n📅 Due today: ${dueToday}\n📁 Total records: ${all.length}`;
  }

  function handleRevenue() {
    const all = store.getAll();
    const now = new Date();
    const monthStart = `01-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    // Count members renewed this month (paidLast > 0, lastUpdated this month)
    const monthStr = now.toISOString().slice(0, 7); // YYYY-MM
    const thisMonth = all.filter(m => m.lastUpdated?.startsWith(monthStr) && m.paidLast > 0);
    const total = thisMonth.reduce((sum, m) => sum + m.paidLast, 0);
    const fullCount = thisMonth.filter(m => m.paidLast === config.renewal.fullAmount).length;
    const referralCount = thisMonth.filter(m => m.paidLast === config.renewal.referralAmount).length;
    const joinCount = thisMonth.filter(m => m.paidLast === config.joining.fee && m.joinDate?.includes(now.toISOString().slice(0, 7).replace('-', '-'))).length;

    const monthName = now.toLocaleString('en-IN', { month: 'long' });
    return `💰 Revenue — ${monthName} ${now.getFullYear()}\n\nTotal: ₹${total}\n• ${fullCount} full renewals @ ₹${config.renewal.fullAmount}\n• ${referralCount} referral renewals @ ₹${config.renewal.referralAmount}`;
  }

  function handleGroups() {
    const lines = config.paidGroups.map((g, i) => `${i + 1}. ${g}`).join('\n');
    return `👥 PAID GROUPS (${config.paidGroups.length}):\n\n${lines}`;
  }

  function handlePing(sock) {
    const uptimeMs = Date.now() - botStartTime;
    const uptime = Math.floor(uptimeMs / 60000);
    const connected = !!sock?.user;
    return `🟢 Bot ${config.botName} is alive\nUptime: ${uptime} minutes\nWhatsApp: ${connected ? '✅ Connected' : '❌ Disconnected'}`;
  }

  function handleHelp() {
    return `📋 MEMBER BOT — COMMANDS

👤 Members
add [phone] [name]       Add new member
kick [phone]             Remove from all groups
skip [phone] [reason]    Skip this month
unskip [phone]           Revert skip
approve [phone]          Approve pending join requests
links [phone]            Invite links for missing groups
groupcheck [phone]       Which groups is member in?

💰 Renewals
renewed [phone]          Mark renewed ₹${config.renewal.fullAmount} (default)
renewed [phone] 45       Mark renewed ₹${config.renewal.referralAmount} (referral)
due                      Due today
due tomorrow             Due tomorrow
overdue                  Overdue list
pending                  Due but not confirmed

🔍 Lookup
find [phone/name]        Member details (partial name match)
status [phone]           Quick status + days till renewal

📊 Reports
summary                  Today's summary with revenue
stats                    Active / removed / overdue counts
revenue                  This month's revenue
groups                   List all ${config.paidGroups.length} group IDs

⚙️ Bot
help                     This list
ping                     Check bot alive + uptime

📋 Overdue Actions (reply to overdue list)
R[n] = Remove  S[n] = Skip  W[n] = Warn
Example: R1 R2 S3`;
  }

  return { handleSummary, handleStats, handleRevenue, handleGroups, handlePing, handleHelp };
}
```

- [ ] **Commit**

```bash
git add core/handlers/reportHandlers.js
git commit -m "feat: report handlers (summary with revenue, stats, revenue, groups, ping, help)"
```

---

## Task 11: commandParser.js

**Files:**
- Create: `core/commandParser.js`

commandParser receives every private message from the owner, routes to the correct handler, and returns the reply string.

- [ ] **Create `core/commandParser.js`**

```javascript
import { normalizePhone } from './globalConfig.js';
import { createMemberHandlers } from './handlers/memberHandlers.js';
import { createRenewalHandlers } from './handlers/renewalHandlers.js';
import { createLookupHandlers } from './handlers/lookupHandlers.js';
import { createReportHandlers } from './handlers/reportHandlers.js';

// Active overdue list for R1/S1/W1 reply parsing
let activeOverdueList = [];

export function createCommandParser(store, groupManager, config, log, sock, botStartTime) {
  const memberH = createMemberHandlers(store, groupManager, config, log);
  const renewalH = createRenewalHandlers(store, config, log);
  const lookupH = createLookupHandlers(store, config, log);
  const reportH = createReportHandlers(store, config, botStartTime, log);

  // Check if message is an overdue action reply (R1, S1 R2, etc.)
  function isOverdueAction(text) {
    return /^([RSW]\d+\s*)+$/i.test(text.trim());
  }

  async function handleOverdueActions(text) {
    const actions = text.trim().toUpperCase().match(/[RSW]\d+/g) || [];
    if (activeOverdueList.length === 0) return '❌ No active overdue list. Send "overdue" first.';

    const results = [];
    for (const action of actions) {
      const type = action[0];
      const idx = parseInt(action.slice(1), 10) - 1;
      if (idx < 0 || idx >= activeOverdueList.length) {
        results.push(`❌ ${action}: invalid number`);
        continue;
      }
      const member = activeOverdueList[idx];
      if (type === 'R') {
        const reply = await memberH.handleKick([member.phone]);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'S') {
        const reply = await memberH.handleSkip([member.phone, 'overdue-skipped']);
        results.push(`${action}: ${reply.split('\n')[0]}`);
      } else if (type === 'W') {
        // Send overdue message to member
        const msg = config.messages.overdue
          .replace('{name}', member.name)
          .replace('{days}', Math.abs(member.daysOverdue || 0));
        try {
          await sock.sendMessage(`91${member.phone}@s.whatsapp.net`, { text: msg });
          results.push(`${action}: ⚠️ Warning sent to ${member.name}`);
        } catch (err) {
          results.push(`${action}: ❌ Failed to send warning — ${err.message}`);
        }
      }
    }
    return results.join('\n');
  }

  async function parse(text, sendFn) {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Check overdue action reply first
    if (isOverdueAction(trimmed)) {
      return handleOverdueActions(trimmed);
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (cmd) {
        // Member management
        case 'add':       return memberH.handleAdd(args);
        case 'kick':      return memberH.handleKick(args);
        case 'skip':      return memberH.handleSkip(args);
        case 'unskip':    return memberH.handleUnskip(args);
        case 'approve':   return memberH.handleApprove(args);
        case 'links':     return memberH.handleLinks(args);
        case 'groupcheck': return memberH.handleGroupCheck(args);

        // Renewals
        case 'renewed':   return renewalH.handleRenewed(args);
        case 'due':       return renewalH.handleDue(args);
        case 'overdue': {
          const result = renewalH.handleOverdue();
          // Cache overdue list for R1/S1 replies
          const active = store.getActive();
          activeOverdueList = active
            .filter(m => {
              const days = (await import('./globalConfig.js')).daysFromToday(m.billingDate);
              return days !== null && days < 0;
            })
            .map(m => ({ ...m, daysOverdue: Math.abs((await import('./globalConfig.js')).daysFromToday(m.billingDate)) }))
            .sort((a, b) => b.daysOverdue - a.daysOverdue);
          return result;
        }
        case 'pending':   return renewalH.handlePending();

        // Lookup
        case 'find':      return lookupH.handleFind(args);
        case 'status':    return lookupH.handleStatus(args);

        // Reports
        case 'summary':   return reportH.handleSummary(args);
        case 'stats':     return reportH.handleStats();
        case 'revenue':   return reportH.handleRevenue();
        case 'groups':    return reportH.handleGroups();
        case 'ping':      return reportH.handlePing(sock);
        case 'help':      return reportH.handleHelp();

        default:
          return `❓ Unknown command: "${cmd}". Send 'help' for full list.`;
      }
    } catch (err) {
      log.error(`❌ Handler error for cmd "${cmd}": ${err.message}`);
      return `❌ Error processing command: ${err.message}`;
    }
  }

  // Update overdue list cache (used by overdueEngine in Sprint 2)
  function setOverdueList(list) {
    activeOverdueList = list;
  }

  return { parse, setOverdueList };
}
```

> **Note:** The `overdue` command has an async import in a switch — refactor it to precompute the list using the already-imported `daysFromToday` from `globalConfig.js` at the top. Replace the dynamic import inside the switch:

After creating the file, fix the `overdue` case to avoid dynamic import:

```javascript
// At top of commandParser.js, add import:
import { daysFromToday } from './globalConfig.js';

// Replace the 'overdue' case with:
case 'overdue': {
  const result = renewalH.handleOverdue();
  activeOverdueList = store.getActive()
    .filter(m => daysFromToday(m.billingDate) !== null && daysFromToday(m.billingDate) < 0)
    .map(m => ({ ...m, daysOverdue: Math.abs(daysFromToday(m.billingDate)) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  return result;
}
```

- [ ] **Commit**

```bash
git add core/commandParser.js
git commit -m "feat: command parser with full routing, overdue action reply (R1/S1/W1)"
```

---

## Task 12: core/index.js (Baileys Connection — Adapted)

**Files:**
- Create: `core/index.js`

Port the Baileys connection state machine from taxi bot. Key differences for this bot:
- Listen to **private messages** (JID ends in `@s.whatsapp.net`), not group messages
- Only process messages from the owner JID
- No fingerprint deduplication needed (commands, not forwards)
- Wire up commandParser on each message

- [ ] **Create `core/index.js`**

```javascript
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

  // Normalize owner JID for comparison
  const ownerJid = `${config.ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`;
  log.info(`👑 Owner JID: ${ownerJid}`);

  // Initialize sheet + store
  log.info('📊 Connecting to Google Sheets...');
  const sheetClient = await createSheetClient(config.serviceAccountPath, config.sheetId);
  const store = createMemberStore(sheetClient, config.botName);
  await store.initialize();
  log.info(`✅ Sheet loaded: ${store.getAll().length} members in cache`);

  // ============================================================
  // SOCKET TEARDOWN
  // ============================================================
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

  // ============================================================
  // RECONNECT (exponential backoff — ported from taxi bot)
  // ============================================================
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

  // ============================================================
  // MESSAGE HANDLER
  // ============================================================
  async function handleMessage(msg) {
    // Only private messages (DMs)
    if (!msg.key.remoteJid?.endsWith('@s.whatsapp.net')) return;
    if (msg.key.fromMe) return;

    // Owner-only gate
    if (msg.key.remoteJid !== ownerJid) {
      log.warn(`🚫 Message from non-owner: ${msg.key.remoteJid}`);
      return;
    }

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    log.info(`📥 Owner command: "${text.substring(0, 80)}"`);

    const reply = await commandParser.parse(text);
    if (reply) {
      try {
        await sock.sendMessage(ownerJid, { text: reply });
        log.info(`📤 Reply sent (${reply.length} chars)`);
      } catch (err) {
        log.error(`❌ Send failed: ${err.message}`);
      }
    }
  }

  // ============================================================
  // BAILEYS CONNECTION
  // ============================================================
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

      // Wire up commandParser with live sock reference
      const groupManager = createGroupManager(sock, config, log);
      commandParser = createCommandParser(store, groupManager, config, log, sock, BOT_START_TIME);

      sock.ev.on('creds.update', async () => { if (saveCreds) await saveCreds(); });

      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          log.info('📱 QR Code generated — scan with WhatsApp');
          latestQR = qr;
          qrTimestamp = Date.now();
          const term = (await import('qrcode-terminal')).default;
          term.generate(qr, { small: true });
        }

        if (connection === 'open') {
          log.info('✅ CONNECTED — Member Bot operational');
          log.info(`👑 Owner: ${ownerJid}`);
          latestQR = null;
          reconnectAttempts = 0;
          // Refresh store on reconnect
          await store.refresh();
          log.info(`📊 Cache refreshed: ${store.getAll().length} members`);
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

  // ============================================================
  // HTTP SERVER (QR + health)
  // ============================================================
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

  // ============================================================
  // GRACEFUL SHUTDOWN (ported from taxi bot)
  // ============================================================
  async function gracefulShutdown(signal) {
    log.info(`👋 ${signal} — shutting down`);
    isShuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    destroySocket('shutdown');
    log.info('✅ Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

  // ============================================================
  // BOOT
  // ============================================================
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`🚀 ${config.botName} — Member Management Bot`);
  log.info(`   Groups: ${config.paidGroups.length} | Owner DM only`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startHttpServer();
  await connectToWhatsApp();
}
```

- [ ] **Commit**

```bash
git add core/index.js
git commit -m "feat: Baileys connection adapted for owner DM commands, wired to command parser"
```

---

## Task 13: Bot Entry Point + PM2 Config

**Files:**
- Create: `bots/bot-nitin/start.js`
- Create: `ecosystem.config.cjs`

- [ ] **Create `bots/bot-nitin/start.js`** (port from taxi bot)

```javascript
#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../core/globalConfig.js';
import { startBot } from '../../core/index.js';
import { createLogger } from '../../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const BOT_DIR = path.dirname(__filename);
const AUTH_DIR = path.join(BOT_DIR, 'baileys_auth');

const BOT_NAME = process.env.BOT_NAME || path.basename(BOT_DIR);
const log = createLogger(BOT_NAME);

log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log.info(`🟢 ${BOT_NAME} — starting`);
log.info(`   Bot Dir : ${BOT_DIR}`);
log.info(`   Auth Dir: ${AUTH_DIR}`);
log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const config = loadConfig(BOT_DIR);
config.botDir = BOT_DIR;

await startBot(config, log, AUTH_DIR);
```

- [ ] **Create `ecosystem.config.cjs`**

```javascript
module.exports = {
  apps: [
    {
      name: 'bot-nitin',
      script: './bots/bot-nitin/start.js',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      restart_delay: 8000,
      exp_backoff_restart_delay: 100,
      min_uptime: 20000,
      max_restarts: 5,
      kill_timeout: 15000,
      kill_signal: 'SIGTERM',
      shutdown_with_message: true,
      max_memory_restart: '500M',
      start_delay: 0,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/bot-nitin-error.log',
      out_file: './logs/bot-nitin-out.log',
      merge_logs: true,
      log_type: 'raw',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata',
        NODE_OPTIONS: '--max-old-space-size=480',
        BOT_NAME: 'bot-nitin',
        STATS_PORT: '3010',
      },
    },
  ],
};
```

- [ ] **Commit**

```bash
git add bots/bot-nitin/start.js ecosystem.config.cjs
git commit -m "feat: bot entry point and PM2 ecosystem config"
```

---

## Task 14: First Boot — Scan QR and Smoke Test

> This is the integration test. Run the bot, scan QR, send commands from your WhatsApp.

- [ ] **Start bot in dev mode**

```bash
node bots/bot-nitin/start.js
```

Expected log output:
```
[bot-nitin] 🚀 bot-nitin — Member Management Bot
[bot-nitin] ✅ Sheet loaded: N members in cache
[bot-nitin] 📱 QR Code generated — scan with WhatsApp
```

- [ ] **Scan QR** — either from terminal printout or open `http://localhost:3010/qr` in browser

Expected after scan:
```
[bot-nitin] ✅ CONNECTED — Member Bot operational
[bot-nitin] 👑 Owner: 919XXXXXXXXX@s.whatsapp.net
[bot-nitin] 📊 Cache refreshed: N members
```

- [ ] **Send test commands from your WhatsApp (owner number → support number)**

Send each command and verify the reply:

```
ping
```
Expected: `🟢 Bot bot-nitin is alive\nUptime: 0 minutes\nWhatsApp: ✅ Connected`

```
help
```
Expected: Full command list

```
stats
```
Expected: Active/removed/overdue counts from your migrated data

```
due
```
Expected: List of members due today (or "No members due today")

```
find [any name from your sheet]
```
Expected: Member details card

```
status [any phone from your sheet]
```
Expected: Status + billing days

- [ ] **Test error handling**

```
add
```
Expected: `❌ Missing arguments. Format: add [phone] [name]`

```
find xxxxxxxxxx
```
Expected: `❌ No member found for xxxxxxxxxx.`

```
blahblah
```
Expected: `❓ Unknown command: "blahblah". Send 'help' for full list.`

- [ ] **Test add command with a test number** (use a number you control)

```
add [your test phone] Test Member
```

Expected:
```
✅ Added Test Member to N/11 groups
```

Then verify the row appeared in Google Sheet.

- [ ] **Test kick command on the test member**

```
kick [your test phone]
```

Expected: `✅ Removed Test Member from N/11 groups`

Verify STATUS changed to REMOVED in Google Sheet.

- [ ] **Commit final integration notes**

```bash
git add .
git commit -m "feat: Sprint 1 complete — bot live, commands working, sheet integration verified"
```

---

## Sprint 1 Exit Checklist

- [ ] Google Cloud setup complete, service account created
- [ ] MEMBERS sheet created with correct headers
- [ ] `migrate.js` ran clean — active members in sheet
- [ ] Bot connects via QR and stays connected
- [ ] `ping` responds correctly
- [ ] `help` returns full command list
- [ ] `stats`, `due`, `find`, `status` return correct sheet data
- [ ] `add` writes to sheet AND attempts group adds
- [ ] `kick` removes from groups AND marks REMOVED in sheet
- [ ] `renewed` defaults to ₹90, accepts 45 override, updates billing date
- [ ] All error cases return clear formatted messages
- [ ] Phone normalization handles +91, 91, 0, and 10-digit formats
- [ ] `groupcheck` shows correct group membership
- [ ] `summary` includes revenue breakdown

---

## Sprint 2 Preview (Next Session)

Phase 3 — Scheduled Jobs:
- `core/scheduler.js` — cron jobs using times from config.json
- `core/reminderSender.js` — rate-limited reminder + QR image sender
- `core/overdueEngine.js` — day 6 auto-reminder, day 7 consolidated list to owner
- Wire scheduler into `core/index.js` boot sequence
