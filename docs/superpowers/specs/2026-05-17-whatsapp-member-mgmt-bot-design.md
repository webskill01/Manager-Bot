# WhatsApp Member Management Bot — Design Spec
**Date:** 2026-05-17
**Status:** Approved

---

## 1. Goal

A WhatsApp bot running on the owner's support number that automates paid subscription group management for 400–841+ members across 11 WhatsApp groups at ₹90/month. Single source of truth: Google Sheets. Multibot architecture so friends can run their own instance on the same VPS.

---

## 2. Clarifications & Decisions

| Decision | Choice | Reason |
|---|---|---|
| Phase structure | Merged Phase 1+2 into Sprint 1 | Get a live responding bot + real sheet early |
| Data migration | Fresh sheet, paste only active members via staging CSV | Don't carry removed members into the new system |
| Support number state | Stale Baileys session (2-3 months idle) — clean QR scan needed | — |
| Group JIDs | Owner already has all 11 | No need for listgroups discovery flow |
| Google Cloud | Starting from scratch | Covered in Sprint 1 setup steps |
| Development | Local Windows → deploy to Contabo VPS | — |
| Taxi bot source | Available locally at `OneDrive/Desktop/whatsapp-taxi-bot-multibot` | Port anti-ban + Baileys connection directly |

---

## 3. Architecture

### Two-Number Setup
- **Bot number:** Continues running taxi bot — untouched
- **Support number:** This bot runs here. Members already trust this number for payment queries.

### Multibot Pattern
One shared `core/` used by all instances. Each instance has its own `bots/bot-name/` folder with isolated config, auth, QR image, and service account.

```
member-mgmt-bot/
├── core/
│   ├── index.js              # Baileys connection + anti-ban (ported from taxi bot)
│   ├── sheetClient.js        # Google Sheets read/write/update
│   ├── commandParser.js      # Owner-only WhatsApp command router
│   ├── groupManager.js       # Add/remove/approve across groups
│   ├── scheduler.js          # Cron jobs — times loaded from config
│   ├── reminderSender.js     # Rate-limited message + QR sender
│   ├── overdueEngine.js      # Overdue detection + numbered list builder
│   ├── memberStore.js        # In-memory cache + sheet sync
│   ├── logger.js             # Bot-prefixed Pino logging
│   └── globalConfig.js       # Loads and validates config.json
│
├── bots/
│   └── bot-nitin/
│       ├── config.json       # ALL tweakable settings (single source for non-code changes)
│       ├── .env              # BOT_NAME, OWNER_NUMBER, SHEET_ID, PORT
│       ├── start.js
│       ├── baileys_auth/     # Fresh session folder
│       └── qr-payment.jpg
│
├── scripts/
│   └── migrate.js            # One-time: staging.csv → normalize → write to sheet
│
├── logs/
├── ecosystem.config.cjs      # PM2 config
└── package.json
```

---

## 4. config.json — All Tweakable Settings

Every value a non-developer might need to change lives here. No magic numbers in code.

```json
{
  "botName": "bot-nitin",
  "paidGroups": [
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

---

## 5. Google Sheet Structure

### Sheet Name: `MEMBERS`

| Column | Type | Description |
|---|---|---|
| NAME | Text | Member display name |
| PHONE | Text | Normalized 10-digit |
| JOIN_DATE | Date | DD-MM-YYYY |
| BILLING_DATE | Date | DD-MM-YYYY — next renewal due |
| STATUS | Enum | `ACTIVE` / `REMOVED` / `SKIPPED` |
| RENEWALS | Number | Count of successful renewals |
| PAID_LAST | Number | Amount paid last time (90 or 45) |
| REFERENCE | Text | Phone of referrer (blank if none) |
| SKIP_REASON | Text | Blank unless SKIPPED |
| ADDED_BY | Text | Bot instance name |
| LAST_UPDATED | DateTime | ISO timestamp of last write |

### Migration Approach
1. Owner manually copies active members from both existing sheets into `scripts/staging.csv`
2. `migrate.js` reads staging CSV, normalizes phones, validates dates, sets STATUS=ACTIVE, writes to new sheet
3. Script runs duplicate phone check + blank date check before writing — aborts on errors

---

## 6. Commands

### All commands are manual (owner-only) and work at any time

**Member Management**
```
add [phone] [name]        Add new member + attempt all 11 groups
kick [phone]              Remove from all groups + mark REMOVED
skip [phone] [reason]     Mark SKIPPED — won't appear in auto-remove list
unskip [phone]            Revert SKIPPED → ACTIVE
links [phone]             Invite links for groups they're missing from
approve [phone]           Approve pending join requests across all groups
groupcheck [phone]        Which of the 11 groups is this member in?
```

**Renewals**
```
renewed [phone]           Mark renewed @ ₹90 (default)
renewed [phone] 45        Mark renewed @ ₹45 (referral discount)
due                       Who's due today
due tomorrow              Who's due tomorrow
overdue                   Full overdue list with day count
pending                   Members whose billing date passed, no renewal logged
```

**Lookup**
```
find [phone]              Full member details
find [name]               Search by name — case-insensitive partial match, returns all results
status [phone]            Quick status + days till renewal
```

**Reports**
```
summary                   Today's summary (see format below)
summary [month]           Monthly summary (e.g. summary may)
stats                     Total active / removed / overdue / skipped counts
revenue                   This month's confirmed total revenue
groups                    List all 11 group names + IDs
```

**Bot**
```
help                      Full command list with formats
ping                      Bot alive check — replies with uptime + sheet connection status
```

**Overdue Actions (reply format)**
```
R[n]                      Remove member #n from all groups
S[n]                      Skip member #n this month
W[n]                      Send another warning to member #n
R1 R2 S3                  Multiple actions in one message
```

---

## 7. Error Handling

Every command validates before acting. No silent failures.

| Error | Bot Response |
|---|---|
| Wrong phone format | `❌ Invalid number. Use 10 digits: add 98551XXXXX Name` |
| Member not found | `❌ No member found for 98551XXXXX. Try: find [name]` |
| Missing arguments | `❌ Missing arguments. Format: add [phone] [name]` |
| `add` on ACTIVE member | `⚠️ Harpreet (98551XXXXX) already ACTIVE. Use 'renewed' to update billing.` |
| `kick` on already REMOVED | `⚠️ Already marked REMOVED. Not in any groups.` |
| Sheet write failure | Retry once → alert owner with error if still failing |
| Unknown command | `❓ Unknown command. Send 'help' for full list.` |

**Phone normalization** — all of these accepted and normalized to 10 digits:
- `98551XXXXX` (10 digits — pass through)
- `+9198551XXXXX` (with +91 prefix)
- `9198551XXXXX` (with 91 prefix)
- `098551XXXXX` (with leading 0)

---

## 8. Scheduled Jobs

All times IST, loaded from `config.json schedule` block.

| Time | Job |
|---|---|
| 9:00 AM | Morning digest — who's due today |
| 9:30 AM | Send renewal reminders + QR (rate-limited, batched) |
| 10:00 PM | Evening auto-summary |
| Continuous | Overdue detection — flags at day 6 and day 7 |

### Overdue Flow
- **Day 6:** Bot auto-sends reminder to member (no owner input)
- **Day 7+:** Bot sends ONE consolidated numbered list to owner

```
📋 OVERDUE MEMBERS (3):

[1] Harpreet • 98551XXXXX • 8 days overdue
[2] Rajesh • 97791XXXXX • 7 days overdue
[3] Manjeet • 84276XXXXX • 6 days overdue

Reply: R1=Remove, S1=Skip, W1=Warn
Example: R1 R2 S3
```

**Bot NEVER auto-removes anyone.** Removal always requires explicit owner command.

---

## 9. Daily Summary Format (10:00 PM Auto-Send)

```
📊 Daily Summary — 17 May 2026

➕ New Members: 3 (₹270)
   • Harpreet Singh • 98551XXXXX
   • Rajesh Kumar • 97791XXXXX
   • Manjeet Kaur • 84276XXXXX

♻️ Renewals: 7
   • 5 full @ ₹90 = ₹450
   • 2 referral @ ₹45 = ₹90

💰 Today's Revenue: ₹810
   (Joins ₹270 + Renewals ₹540)

❌ Removals: 4
⚠️ Overdue (6+ days): 2
👥 Total Active: 412
```

Revenue = (new members × ₹90) + (full renewals × ₹90) + (referral renewals × ₹45)

---

## 10. Anti-Ban & Rate Limiting

Ported directly from `OneDrive/Desktop/whatsapp-taxi-bot-multibot`.

- 10–15s random gap between member-to-member messages (values from config)
- 10–15s random gap between group operations
- Circuit breaker: 10 failures → 60s cooldown
- Per-group cooldown: minimum 1s between sends to same group
- Batch limit: max 20 outbound messages per scheduled run
- Second batch (if > 20 due today): waits 2 hours before sending remainder

---

## 11. Sprint 1 Exit Criteria

- [ ] Google Cloud project created, Sheets API enabled, service account + JSON key ready
- [ ] New MEMBERS sheet created and shared with service account
- [ ] `migrate.js` runs clean — active members written to sheet with no errors
- [ ] Bot connects via QR scan and stays connected
- [ ] `add` writes to sheet AND attempts group adds with correct reporting
- [ ] `kick` removes from all groups AND marks REMOVED in sheet
- [ ] `renewed` defaults to ₹90, accepts 45 override, updates billing date +30 days
- [ ] `find`, `due`, `overdue`, `status`, `pending` return correct data
- [ ] `ping` responds with uptime + sheet status
- [ ] `help` returns full command list
- [ ] All error cases return clear, formatted error messages
- [ ] Phone normalization handles all 4 input formats

---

## 12. Tech Stack

| Tool | Purpose |
|---|---|
| Baileys v6.7+ | WhatsApp Web protocol |
| Google Sheets API v4 | Member data — single source of truth |
| node-cron | Scheduled jobs (IST) |
| Express | QR endpoint + health check |
| Pino | Structured logging with bot prefix |
| PM2 | Process management, auto-restart, log rotation |
| Node.js 18+ | Runtime |

---

## 13. Out of Scope

- Free group (1 group) — managed manually by owner, bot does not touch it
- Financial tracking sheet (PER MONTH SHEET) — owner manages manually using daily summary as input
- Revenue split between partners — manual using bot's daily summary
- Multibot templatization for friends — Phase 5, separate sprint
