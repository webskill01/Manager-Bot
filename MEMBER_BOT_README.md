# WhatsApp Group Member Management Bot

A production-grade WhatsApp automation system for managing paid subscription groups — built on **Baileys** (direct WhatsApp Web protocol), reading and writing directly to **Google Sheets** as the single source of truth.

---

## 🧩 Problem Statement

Managing 400+ paid members across 11 WhatsApp groups manually involves:

- **Adding members** — sharing 11 group links, accepting join requests across all groups manually
- **Renewal reminders** — filtering Excel by date daily, copy-pasting numbers, sending personalized message + QR photo one by one
- **Removing non-renewals** — finding overdue members, removing from 11 groups individually (7 removals = 77 manual actions)
- **Record keeping** — noting renewals in a temp WhatsApp chat, updating two Excel sheets at end of day
- **No status awareness** — no automated way to know who's overdue, who's skipped, who's active

**Scale:** 400–841+ members, ₹90/month, 11 paid groups + 1 free group, with partner revenue split.

---

## ✅ Solution Overview

A **WhatsApp bot** running on the support/personal number that:

1. Reads and writes directly to a structured Google Sheet (single source of truth)
2. Sends scheduled renewal reminders with human-like rate limiting
3. Adds/removes members from all 11 groups automatically with gaps
4. Accepts simple commands from the owner's private chat
5. Sends daily summaries (morning digest + evening report)
6. Is architected as a **multibot** so friends running similar subscription groups can run their own instance

The financial tracking sheet remains separate — owner manages it manually using the bot's daily summaries as input.

---

## 🏗️ Architecture

### Two-Number Setup
- **Bot number (existing):** Continues forwarding taxi messages via the existing taxi multibot — untouched
- **Support number (existing):** This bot runs here. Members already trust and respond to this number for payment queries

### Multibot Architecture (same pattern as taxi bot)
```
member-mgmt-bot/
├── core/                        # Shared logic — all instances use this
│   ├── index.js                 # Baileys connection + anti-ban hardening
│   ├── sheetClient.js           # Google Sheets API read/write
│   ├── commandParser.js         # WhatsApp command handler
│   ├── groupManager.js          # Add/remove/approve across groups
│   ├── scheduler.js             # Cron jobs — reminders, digest, summary
│   ├── reminderSender.js        # Rate-limited message sender
│   ├── overdueEngine.js         # Overdue detection + numbered action list
│   ├── memberStore.js           # In-memory cache + sheet sync
│   ├── logger.js                # Bot-prefixed logging
│   └── globalConfig.js          # Shared constants
│
├── bots/
│   ├── bot-nitin/               # Your instance
│   │   ├── .env                 # BOT_NAME, OWNER_NUMBER, SHEET_ID, PORT
│   │   ├── config.json          # Group IDs, QR path, message templates
│   │   ├── start.js
│   │   ├── baileys_auth/
│   │   └── qr-payment.jpg       # Your UPI QR image
│   │
│   ├── bot-friend1/             # Friend's instance
│   │   ├── .env
│   │   ├── config.json          # Their sheet, their 11 groups, their QR
│   │   └── start.js
│   │
│   └── bot-friend2/
│       └── ...
│
├── logs/
├── ecosystem.config.cjs         # PM2 process manager
└── package.json
```

### Bot Instance `config.json`
```json
{
  "botName": "bot-nitin",
  "ownerNumber": "919XXXXXXXXX@s.whatsapp.net",
  "sheetId": "YOUR_GOOGLE_SHEET_ID",
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
  "reminderMessage": "Sat Sri Akal {name} ji 🙏\n\nAapki group membership aaj renew honi hai.\nPlease ₹90 is QR code se bhejo aur screenshot share karo.\n\nShukriya! 🚕",
  "overdueMessage": "Sat Sri Akal {name} ji 🙏\n\nAapki membership {days} din se overdue hai.\nPlease jaldi renew karo warna group se remove karna padega.\n\n₹90 bhejo aur screenshot share karo. 🙏"
}
```

---

## 📊 Google Sheet Structure (New — Bot-Managed)

### Sheet Name: `MEMBERS`

| Column | Type | Description |
|--------|------|-------------|
| NAME | Text | Member display name |
| PHONE | Text | Normalized 10-digit (no dashes/spaces) |
| JOIN_DATE | Date | DD-MM-YYYY — actual join date |
| BILLING_DATE | Date | DD-MM-YYYY — next renewal due date |
| STATUS | Enum | `ACTIVE` / `REMOVED` / `SKIPPED` |
| RENEWALS | Number | Count of successful renewals |
| PAID_LAST | Number | Amount paid last time (90 or 45) |
| REFERENCE | Text | Phone of who referred them (blank if none) |
| SKIP_REASON | Text | Blank unless SKIPPED — e.g. "admin", "personal" |
| ADDED_BY | Text | Bot instance name that added this member |
| LAST_UPDATED | DateTime | ISO timestamp of last write |

**Key design decisions:**
- Full dates (DD-MM-YYYY) instead of just day numbers — no cross-month ambiguity
- Phone normalized to 10 digits on every write — enables reliable matching
- STATUS column replaces the old RENEWAL=0/1/blank system
- BILLING_DATE auto-updates to +30 days on every confirmed renewal
- SKIP_REASON allows nuance — admin of another group, personal situation, etc.

### Data Migration from Old Sheet

Old sheet mapping:
- `RENEWAL = blank or 1` → STATUS = `ACTIVE`
- `RENEWAL = 0` → STATUS = `REMOVED`
- `Billing Date` = day number → convert to full date using MONTH OF JOIN
- Phone numbers → strip dashes, spaces, normalize to 10 digits

A migration script will be built in Phase 1 to do this automatically.

---

## ⚡ Features

### 1. Scheduled Jobs (IST timezone locked)

> **Superseded 18 Aug 2026** — the table below describes the original design. What actually
> runs now is listed here. Every job jitters 0-20 min and nothing on a timer messages a member.

| Time | Job | Delivers to |
|------|-----|-------------|
| 6:00 AM | `morning-digest` — who's due today | Telegram (operators) |
| 6:30 / 7:30 AM | `reminder-send` / `-2` | **inert** until `reminderChannel: "cloudapi"` |
| 9:00 AM | `drip-arm` — starts the day's tap-link drip | Telegram (drip owner) |
| 10:00 AM | `overdue-check` | **inert** until the Cloud API is live |
| 10:00 PM | `evening-summary` | Telegram (operators) |

Bots with a Telegram listener register the digests and the drip; bots without register
neither. Telegram-only bots (the friend bots) have no reminder jobs at all, so they show
**3 jobs active** where bot-nitin shows 6.

### 2. Renewal Reminder Flow

For each member due today:
1. Bot sends personalized message with their name
2. Bot sends QR image
3. 10–15 second gap before next member
4. Maximum 20 per batch; if more, second batch after 2 hours

### 3. Overdue Handling (Smart Numbered System)

On day 6, bot auto-sends reminder to the member (no owner input needed).

On day 7, bot sends ONE consolidated message to you (not separate messages per person):

```
📋 OVERDUE MEMBERS (7+ days):

[1] Harpreet • 98551XXXXX • 8 days overdue
[2] Rajesh • 97791XXXXX • 7 days overdue
[3] Manjeet • 84276XXXXX • 6 days overdue

Reply with actions:
R1 = Remove #1 from all groups
S1 = Skip #1 this month (won't auto-remove)
W1 = Send another warning to #1
R1 R2 S3 = Multiple actions in one reply
```

You reply with e.g. `R1 R2 S3` — bot parses, executes each action with gaps. No confusion about which reply maps to which person.

**Important:** Bot NEVER auto-removes anyone. Removal always requires your explicit command. This prevents accidental kicks of group admins or members with special situations.

### 4. Add Member Flow

You send: `add 98551XXXXX Harpreet`

Bot:
1. Normalizes phone, writes to Google Sheet with STATUS=ACTIVE
2. Attempts to add to all 11 groups with 10–15s gaps between each
3. Reports result:

```
✅ Added Harpreet to 8/11 groups
❌ Failed 3 groups (privacy restricted):
   - Punjab Taxi Group 1
   - Punjab Taxi Group 4
   - Punjab Taxi Group 7

Reply LINKS 98551XXXXX to get invite links for failed groups.
```

4. If you reply `LINKS 98551XXXXX` → you get tap-to-send links for the 3 failed groups.
   (Since 18 Aug 2026 the bot never sends these itself — you tap and send from your own phone.)
5. If groups require admin approval → `approve 98551XXXXX` auto-approves across all pending groups

### 5. Remove Member Flow

You send: `kick 98551XXXXX`

Bot:
1. Removes from all 11 groups with 3–5s gaps (11 groups ≈ 33–55 seconds total)
2. Updates STATUS = REMOVED in sheet
3. Logs removal with timestamp
4. Confirms: `✅ Removed Harpreet from 11/11 groups`

### 6. Rate Limiting (Anti-Ban)

All sends use patterns from the taxi bot codebase:
- 10–15s gaps between member-to-member messages
- 3–5s gaps between group operations
- Circuit breaker: 10 failures = 60s cooldown
- Per-group cooldown: minimum 1s between sends to same group
- Batch limits: max 20 outbound messages per scheduled run

---

## 💬 Command Reference

> **Send `help` to the bot for the authoritative, per-bot list** — it's generated from the
> running config and differs between the two profiles. The sections below predate the
> July 2026 rework and are kept for background; where they disagree with `help`, `help` wins.

### Added 24 Aug 2026 — Telegram UX + the shared revenue ledger

**`help` is an index now, not a wall.** Nine sections with a one-line hint each, rendered as
buttons underneath. `help reports` (or a prefix — `help rem`) prints one section; `help all`
still prints everything. Text lives in `core/helpText.js`; the same category list builds both
the text and the buttons, so a dead button or an unreachable section fails a test.

**Phone numbers are tap-to-copy.** Applied once in `telegramTransport.send()`, so every list,
lookup, digest and kick prompt on every bot copies a number when you tap it. Requires
`parse_mode: HTML` — escaping is three characters and cannot fail, where Markdown rejects a
whole message over a `*` in someone's name. `wa.me` links and JIDs are left alone.

**A `/` menu, a button keyboard, and follow-up buttons.** All three are pure Telegram UI over
the same text commands, so `commandParser` never learned about any of it. Follow-ups appear
where a reply was already a menu written as prose: `drip` → start/stop/test, `kickghosts` →
confirm/stop, `stop` → removal/kickall/kickghosts, `delayall 7` → confirm, plus `summary`,
`due`, `upcoming`, `links`, `ledger`. `callback_data` is the LITERAL command, so a button is
indistinguishable from typing it — no pending state, nothing to expire.

> No inline Yes/No on `kick` / `kickall` / `removal`, on purpose. Those remove people from 12
> groups; one accidental tap is a downgrade from having to type the word.

**`ledger` — one shared daily revenue sheet.** Every bot appends its own `(DATE, BOT, NEW,
RENEWED)` row at 10 PM, then at 6 AM recomputes every date back to `startDate` and rewrites
only the rows that differ. That morning pass is the correction, the backfill and the
self-heal at once: a bot down for a week fills its own gap with no intervention.

Four bots share one tab with no locking. A bot only ever touches rows carrying its OWN name,
so two can never target the same row; appends use `INSERT_ROWS`, which allocates server-side
and cannot clobber a row another bot added a millisecond earlier.

The bots write **counts, never rupees** — the operator's own sheet formulas own what a count
is worth. Duplicating fees into four configs would give two answers to "what did we earn on
the 3rd" the first time a price changed.

Commands: `ledger` (status), `ledger now`, `ledger sync` (backfill + correct).

**Cross-bot totals** on the sheet-owning bot only. `summary`, `revenue`, `weekly`, `monthly`
and `digest` end with what the friend bots remitted and the actual profit, READ back from the
operator's SUMMARY tab rather than recomputed. Bots with no `ledger.summaryTab` in their
config — the three friend bots — keep reporting their own money and nothing else.

**Message variants rotate round-robin** down a list instead of hashing on phone+date. The
hash spread evenly across hundreds of members but said nothing about any two *adjacent* ones,
so a 12-person list could hand out the same wording four times running.

**Setup:** `LEDGER_SHEET_ID` goes in `bots/*/.env` (same value on every bot), never in
`config.json` — this repo is public and config.json is committed. `config.json` carries only
layout: `ledger.tab`, `ledger.startDate`, and on the sheet owner `ledger.summaryTab` +
`ledger.summaryColumns`. A bot missing the id says so at boot; `grep 📒 logs/<bot>-out.log`.

---

### Added 18 Aug 2026 — the drip, full friend bots, link rework

**`drip`** — the bot paces your MANUAL reminders instead of you remembering to run `dmlist`.
A 9 AM job builds the day's three cohorts, then pushes one Telegram message every 18-25 min
until 9 PM carrying up to three tap-to-send `wa.me` links (one due-today, one day-N overdue,
one day-M final). You tap and send from your own phone — the bot sends nothing to members.

| Command | Does |
|---|---|
| `drip` | what's been pushed today, what's left, whether it's running |
| `drip test` | push one real batch NOW, ignores the window, **records nothing** |
| `drip stop` / `drip start` | pause for the day / resume |

The sheet is re-read before every push, so anyone who pays mid-day drops off the rest of the
queue. Whatever isn't reached by 9 PM is dropped, not carried — they arrive tomorrow one day
more overdue. A 9 PM report says "N pushed, M NOT reached", so a dead drip and a quiet day
never look the same. `dripIds` in config decides who gets buzzed; `allowedTelegramIds` stays
the command allow-list, so partners keep access and the digests without the notifications.

**Digests are back**, Telegram-only: `morning-digest` (6 AM) and `evening-summary` (10 PM).
They are passed to the scheduler ONLY when the bot has a Telegram listener — no task in, no
job out — so a token-less bot still schedules nothing that could reach WhatsApp.

**Message variants.** `messages.reminder` / `referralReminder` / `overdue` / `finalReminder`
each accept a **string or an array**. Each member gets one picked from their phone + the
date: random across members and months, stable within a day. Identical text to hundreds of
people is a stronger spam signal than any send gap, so this matters more than timing.

**Link sharing changed shape.** `add` and `sendlinks` no longer send anything. They fetch
invite codes **live** from the socket and hand you tap-to-send links, split into batches of
`linkBatchSize` (default 6) so nothing hides behind WhatsApp's "Read more" fold. The old path
fired 13 messages at a fixed 1.2-second interval, and that cadence — not the links — is what
reads as automation. `config.groupLinks` is gone (a stored invite URL dies at the next ban);
`config.groupNames` keeps the labels, which `kick` uses to name the groups to clear by hand.

**`addnew` is deleted** — with `add` no longer sending, they were the same command. Typing it
returns a pointer. `addsilent` stays: it differs on `paidLast: 0`, keeping an existing member
out of join revenue.

**All four bots run `profile: "full"`.** Call tracking (`called`, `log`) works on every
profile now. **`pending` means OVERDUE everywhere** — the call list lives in `log`.

### Added 15 Aug 2026 — bot-nitin hybrid (`transport: "dual"`)

bot-nitin now runs **Baileys and Telegram in one process**, on one command parser and one
sheet cache. Every command works from either channel, and `kick` typed in Telegram really
removes the member from all 12 groups. See **NITIN_HYBRID_SETUP.md**.

```
sent                       What went out today: every member with Meta's message id,
                           every failure with Meta's reason and error code
```

Config: `"transport": "dual"` in config.json plus `TELEGRAM_TOKEN` in the bot's `.env`.
Absent the token it degrades to WhatsApp-only with a warning rather than refusing to boot.

**When the WhatsApp socket dies (403), the process stays up.** Sheet commands keep answering
over Telegram; pure group commands (`approve`, `groupcheck`, `kickghosts`, …) are refused with
the real cause; and `add` / `kick` / `renewed` still write the sheet, so the record stays right
while you do the group half by hand. Every reply carries a banner while the socket is down.

Reminders: all four stages now route through the official Cloud API when
`reminderChannel: "cloudapi"` is set — and never touch the socket, so they survive a ban. A
failure does NOT fall back to a Baileys DM; it is recorded and reported, and you send those
few by hand with `dmlist`. **Unset by default — reminders are still manual.**

### Added 27 Jul 2026

```
digest                     Today's due / overdue / auto-renewed  (was the 6 AM cron)
summary                    Day report                            (was the 10 PM cron)
delayall [days] [confirm]  Bulk-delay everyone overdue. Writes delayUntil only —
                           BILLING_DATE never moves, so no billing day drifts
catchup [days]             Preview who was missed during an outage
catchup [days] confirm     Start now — first group message goes out immediately
catchup [days] confirm 9   Grace applies NOW, first message at 9 AM
catchup status             Stage, who paid, who's left
stop catchup               Cancel (grace stays)
cloudapi                   Show official-API status
cloudapi test [phone]      Send a real test template before flipping the channel
```

**Tracker profile only** (`"profile": "tracker"` — the friend bots):
```
pending                    Who to call now (month up) + who to chase again
called [phone]             You pitched the app. Member stays in the group
moved [phone]              They're on the app → mark MOVED + remove from ALL groups
calls                      Funnel counts + conversion %
```
On tracker bots `pending` means the call list, not the overdue list, and the renewal
commands (`renewed`, `remind`, `due`, `overdue`, `refs`, `kickall`, …) are refused.

**Removed:** the `morning-digest` and `evening-summary` cron jobs, and the daily DM of the
day-7+ removal list. Nothing is pushed to admins on a schedule — see BAN-SAFETY-GUIDELINES.md §5.

### Member Management
```
add [phone] [name]         Add new member + attempt all 11 groups
kick [phone]               Remove from all 11 groups + mark REMOVED
skip [phone] [reason]      Mark SKIPPED — won't appear in auto-remove list
unskip [phone]             Revert SKIPPED → ACTIVE
links [phone]              Get invite links for groups they're missing from
approve [phone]            Approve pending join requests across all groups
```

### Renewal
```
renewed [phone]            Mark renewed @ ₹90, update billing date +30 days
renewed [phone] 45         Mark renewed @ ₹45 (referral discount)
due                        Who's due today
due tomorrow               Who's due tomorrow
overdue                    Full overdue list with days count
pending                    Members due but not yet confirmed paid
```

### Lookup
```
find [phone]               Full member details from sheet
find [name]                Search by name (shows all matches)
status [phone]             Quick status — active/removed/skipped + days till renewal
```

### Summaries
```
summary                    Today's summary
summary [month]            Monthly summary (e.g. summary may)
stats                      Total active, removed, overdue counts
revenue                    This month's confirmed revenue so far
```

### Groups
```
groups                     List all 11 group names + IDs
groupcheck [phone]         Which of the 11 groups is this member in?
```

### Overdue Actions (reply format)
```
R[n]                       Remove member #n from all groups
S[n]                       Skip member #n this month
W[n]                       Send another warning to member #n
R1 R2 S3                   Multiple actions in one message
```

---

## 📈 Daily Summary Format

**Pull it with the `summary` command** (the 10 PM auto-send was removed on 27 Jul 2026):
```
📊 Daily Summary — 17 May 2026

➕ New Members: 3
   • Harpreet Singh • 98551XXXXX
   • Rajesh Kumar • 97791XXXXX
   • Manjeet Kaur • 84276XXXXX

♻️ Renewals: 7 (₹585)
   • 5 full @ ₹90
   • 2 referral @ ₹45

❌ Removals: 4
⚠️ Overdue (6+ days): 2
👥 Total Active: 412
```

You copy these numbers directly into your financial tracking sheet — no reconciliation needed.

---

## 🔧 Tech Stack

| Tool | Purpose |
|------|---------|
| **Baileys** (v6.7+) | WhatsApp Web protocol — direct connection |
| **Google Sheets API** | Single source of truth for member data |
| **node-cron** | Scheduled jobs (IST timezone) |
| **Express** | HTTP server for QR code + health endpoints |
| **Pino** | Structured logging |
| **PM2** | Process management, auto-restart, log rotation |
| **Node.js 18+** | Runtime |

---

## 🚀 Build Phases

### Phase 1 — Foundation
- [ ] Design new Google Sheet (exact column structure above)
- [ ] Create Google Cloud service account + enable Sheets API
- [ ] Write migration script — reads current Sheet 2, normalizes phones, sets full dates, maps STATUS
- [ ] Validate migrated data (duplicate phone check, blank billing date check)

### Phase 2 — Core Bot
- [ ] Baileys connection with anti-ban hardening (port from taxi bot)
- [ ] Google Sheets API client (`sheetClient.js`) — read row, write row, update cell
- [ ] Command parser — listens to owner number only, routes to correct handler
- [ ] Commands: `add`, `kick`, `renewed`, `find`, `status`, `due`, `summary`

### Phase 3 — Scheduled Jobs
- [ ] Morning digest (9:00 AM IST)
- [ ] Renewal reminder sender with rate limiting (9:30 AM IST)
- [ ] Overdue detection engine — builds numbered list
- [ ] Evening auto-summary (10:00 PM IST)
- [ ] Numbered action reply parser (`R1 R2 S3` format)

### Phase 4 — Group Operations
- [ ] Add to groups with gap + privacy failure detection + reporting
- [ ] Kick from groups with gap
- [ ] Approve pending join requests
- [ ] Invite link generation for failed adds
- [ ] `groupcheck` — verify which groups a member is in

### Phase 5 — Multibot Templatization
- [ ] Separate `config.json` per instance (sheet ID, group IDs, QR, templates)
- [ ] PM2 ecosystem config for multiple instances
- [ ] Per-instance logging with bot name prefix
- [ ] Onboarding docs for friends running their own instance

---

## 📦 Setup (Per Instance)

### Prerequisites
```bash
Node.js >= 18
PM2 (npm install -g pm2)
Google Cloud service account with Sheets API enabled
```

### Installation
```bash
git clone <repo-url>
cd member-mgmt-bot
npm install
```

### Google Sheets Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create project → Enable Google Sheets API
3. Create Service Account → Download JSON key
4. Share your Google Sheet with the service account email (Editor access)
5. Place JSON key at `bots/bot-nitin/service-account.json`

### Configure Bot Instance
```bash
# Create bot folder
mkdir -p bots/bot-nitin

# Create .env
BOT_NAME=bot-nitin
OWNER_NUMBER=919XXXXXXXXX
STATS_PORT=3010

# Add config.json (see Architecture section above)
# Add qr-payment.jpg (your UPI QR image)
# Add service-account.json (Google Cloud key)
```

### Run
```bash
# Development
node bots/bot-nitin/start.js

# Production
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### Scan QR
- Terminal: shows automatically
- Browser: `http://localhost:3010/qr`

---

## 🛡️ Safety Guarantees

- **No auto-removal** — every kick requires explicit owner command
- **SKIPPED status** — members never auto-removed if flagged (group admin, personal situation)
- **Rate limited** — all sends use human-like gaps, batch limits, circuit breaker
- **Owner-only commands** — bot only accepts commands from the configured owner number
- **Sheet as truth** — all state lives in Google Sheet, bot restart loses nothing
- **Graceful shutdown** — PM2 SIGTERM handler waits for in-progress operations

---

## 💼 SaaS Potential (Multibot)

Friends running similar subscription taxi groups can run their own instance on your Contabo VPS:

- **Setup fee:** ₹500–1000 (your time to onboard their data + configure their instance)
- **Monthly fee:** ₹500–1000/month (VPS share + maintenance)
- **Your cost per additional instance:** ~50MB RAM on existing VPS — negligible

Each friend connects their own WhatsApp support number, their own Google Sheet, their own 11 group IDs, their own UPI QR. Core logic is shared — you maintain once, all instances benefit.

This folds naturally under the **EaseBuilds** brand alongside WBaaS.

---

## 🔗 Related Projects

- [whatsapp-taxi-bot-multibot](https://github.com/webskill01/whatsapp-taxi-bot-multibot) — The taxi forwarding bot this project runs alongside. Anti-ban patterns, Baileys connection logic, and PM2 ecosystem config are directly ported from here.

---

## 📝 Notes

- Free group (1 group) is managed manually by owner — bot does not touch it
- Financial tracking sheet (Sheet 1 — PER MONTH SHEET) remains manually managed by owner
- Bot only operates on the new structured MEMBERS sheet
- Revenue split tracking between partners is done manually using bot's daily summary output
- Referral discount logic: 1 referral = ₹45 renewal, tracked via REFERENCE column and PAID_LAST
