# bot-3 — Setup Checklist (friend bot, 50-25-25 split)

This folder is scaffolded but **not yet runnable**. It is wired for a **three-way revenue
split** (50% worker / 25% Nitin / 25% partner) via the `split` block in `config.json`.
Fill in the placeholders below, then start it.

## Revenue split
`config.json` contains:
```json
"split": {
  "shares": [
    { "label": "Worker",  "percent": 50 },
    { "label": "Nitin",   "percent": 25 },
    { "label": "Partner", "percent": 25 }
  ]
}
```
- Change `label` to the real names and `percent` to whatever this friend agreed to.
- Percentages are normalized, so they don't have to add up to exactly 100 (but it's cleanest if they do).
- Reports (`summary`, `revenue`, `forecast`, `monthly`) will show one line per person, e.g.
  `Worker (50%): ₹500` / `Nitin (25%): ₹250` / `Partner (25%): ₹250`.
- To make this a plain 50-50 bot instead, delete the whole `split` block — it falls back to
  the legacy `Per person: ₹X` line (same as bot-nitin).

## 1. Google Sheet
- Create a new Google Sheet with a tab named **`MEMBERS`**.
- Header row (row 1), columns A→N **in this exact order** (the bot reads by position, not by label):
  `NAME | PHONE | JOIN_DATE | BILLING_DATE | STATUS | RENEWALS | PAID_LAST | REFERENCE | SKIP_REASON | ADDED_BY | LAST_UPDATED | LAST_RENEWED | REF_CREDIT_DATE | REF_LOG`
- **Share** the sheet (Editor) with the service-account email found inside `service-account.json`.
- Copy the sheet ID from its URL → put it in `.env` as `SHEET_ID`.

## 2. Files to drop in this folder (all gitignored)
- `service-account.json` — copy from `../bot-nitin/` (same Google Cloud project works, as long as the new sheet is shared with it).
- `qr-payment.jpg` — the owner's UPI QR image members receive with reminders.

## 3. Fill in `config.json`
- `split` — set the real names/percentages (see above).
- `paidGroups` — the `…@g.us` IDs of this bot's groups.
- `groupNames` — group labels only, no URLs. `kick` uses them to name the groups to clear by hand.
- `welcomeMessage`, `messages.*` — customise text.
- `renewal.fullAmount` / `referralAmount` / `joining.fee` — this owner's pricing.
- `allowedNumbers` — owner's 10-digit number(s) (these can issue commands).
- `allowedLids` — leave `[]`; filled after first scan (step 6).
- (Optional) add a `trial` block only if this bot runs trial-group purges.

## 4. Fill in `.env`
```env
BOT_NAME=bot-3
OWNER_NUMBER=91XXXXXXXXXX
SHEET_ID=<paste the new sheet ID here>
STATS_PORT=3011
TELEGRAM_TOKEN=<from @BotFather>
LEDGER_SHEET_ID=<the SHARED revenue sheet — same value on every bot>
```
> Ids live in `.env`, never in `config.json`: this repo is public and config.json is
> committed. `LEDGER_SHEET_ID` is identical on all four bots — one shared daily sheet
> they each write their own row into. `git pull` cannot deliver it, so a bot missing it
> warns at boot; check with `grep 📒 logs/bot-abhi-out.log`.

`STATS_PORT` must be unique — bot-nitin=3010, bot-3=3011.

## 5. Start + scan
```bash
pm2 start ecosystem.config.cjs --only bot-3     # or: pm2 reload ecosystem.config.cjs
```
Open the shareable scan page and hand the link to whoever owns the phone:
```
http://<server-ip>:3011/
```
They scan the QR (WhatsApp → Linked devices → Link a device). The page shows ✅ Connected when done.

## 6. Capture the LID
After the first scan, send the bot a DM. It will message the owner an "unknown LID".
Copy that value into `config.json` → `allowedLids`, then:
```bash
pm2 reload ecosystem.config.cjs --only bot-3
```
Now the owner's commands are authorised.
