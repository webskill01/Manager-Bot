# bot-sachin2 — Setup Checklist

This folder is scaffolded but **not yet runnable**. It is a standard member-management bot
(same engine as bot-nitin / bot-abhi). Fill in the placeholders below, then start it.

> **STATS_PORT = 3005** (must be unique — nitin=3010, abhi=3004, sachin2=3005, aayush2=3006).

## 1. Google Sheet
- Create a new Google Sheet with a tab named **`MEMBERS`**.
- Header row (row 1), columns A→N **in this exact order** (the bot reads by position, not by label):
  `NAME | PHONE | JOIN_DATE | BILLING_DATE | STATUS | RENEWALS | PAID_LAST | REFERENCE | SKIP_REASON | ADDED_BY | LAST_UPDATED | LAST_RENEWED | REF_CREDIT_DATE | REF_LOG`
- **Share** the sheet (Editor) with the service-account email found inside `service-account.json`.
- Copy the sheet ID from its URL → put it in `.env` as `SHEET_ID`.

## 2. Files to drop in this folder (all gitignored — NOT created by the scaffold)
- `service-account.json` — copy from `../bot-nitin/` (same Google Cloud project works, as long as the new sheet is shared with it).
- `qr-payment.jpg` — the owner's UPI QR image members receive with reminders.

## 3. Fill in `config.json`
- `paidGroups` — replace the `TODO_…@g.us` placeholder with this bot's real group ID(s).
- `groupNames` — group labels only, no URLs. `kick` uses them to name the groups to clear by hand.
- `welcomeMessage`, `messages.*` — customise the text for this owner.
- `renewal.fullAmount` / `referralAmount` / `joining.fee` — this owner's pricing.
- `allowedNumbers` — owner's 10-digit number(s) (these can issue commands). Replace `TODO_OWNER_10_DIGIT_NUMBER`.
- `allowedLids` — leave `[]`; filled after first scan (step 6).
- (Optional) add a three-way `split` block — see `../bot-abhi/config.json` — only if this bot splits revenue.
- (Optional) add a `trial` block only if this bot runs trial-group purges.

## 4. Fill in `.env`
```env
BOT_NAME=bot-sachin2
OWNER_NUMBER=91XXXXXXXXXX
SHEET_ID=<paste the new sheet ID here>
STATS_PORT=3005
```

## 5. Start + scan
```bash
pm2 start ecosystem.config.cjs --only bot-sachin2     # or: pm2 reload ecosystem.config.cjs
```
Open the shareable scan page and hand the link to whoever owns the phone:
```
http://<server-ip>:3005/
```
They scan the QR (WhatsApp → Linked devices → Link a device). The page shows ✅ Connected when done.

## 6. Capture the LID
After the first scan, send the bot a DM. It will message the owner an "unknown LID".
Copy that value into `config.json` → `allowedLids`, then:
```bash
pm2 reload ecosystem.config.cjs --only bot-sachin2
```
Now the owner's commands are authorised.

---
**Note:** Reminders are restart-safe out of the box. If the bot is offline/restarting across a
scheduled reminder window (6:30 / 7:30 due-today, 10:00 overdue), it catches up automatically on
reconnect and never messages the same member twice — same persistence model as the kickall/removal engine.
