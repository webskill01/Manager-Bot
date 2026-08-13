# bot-nitin — the hybrid setup

Three channels, each doing the one thing it is best at:

| Job | Channel | Why |
|---|---|---|
| Renewal reminders to members | **Official WhatsApp Cloud API** | Meta cannot ban a number for sending its own API's messages. This is what has been getting your personal number flagged, even sending the `dmlist` links by hand. |
| Group ops — `add`, `kick`, `approve` | **Baileys (unchanged)** | The official Groups API only manages groups the business created, capped at 8 members. It can never touch the real ones. There is no alternative and there won't be. |
| Your commands — sheet entries, reports | **Telegram *and* WhatsApp** | Telegram is the backup that survives a ban. Every sheet command keeps working with the WhatsApp number dead. |

**Nothing about the members changes.** They stay in the same WhatsApp groups. They will
see reminders arrive from a new number (the Cloud API one) — the template text has to tell
them to reply on the number they already message.

---

## Part 1 — Telegram (do this now, ~10 minutes)

Independent of everything Meta. Reminders stay manual (`dmlist`) throughout, exactly as
today. This part only gives you a second way to command the bot.

### 1. Create the bot

In Telegram, search **@BotFather**, send `/newbot`:

```
/newbot
→ name:      Nitin Manager        ← display name at the top of the chat
→ username:  nitin_manager_bot    ← the @handle; must be unique and end in "bot"
```

@BotFather is Telegram's official robot that hands out bots — you talk to it once and
never again. The bot you end up with is your own.

It replies with a token like `8123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
**That token is the password to the bot.** Never put it in a group or in git.

### 2. Add the token

In `bots/bot-nitin/.env`, add one line:

```
TELEGRAM_TOKEN=8123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`config.json` already says `"transport": "dual"`. The token is the other half.

> **Until you add it**, bot-nitin logs a warning every start and runs WhatsApp-only. It
> does **not** refuse to boot — a missing backup channel must never take down a live
> renewal bot.

### 3. Enrol yourself

```bash
pm2 restart bot-nitin
```

`allowedTelegramIds` is `[]`, which is **setup mode**: the bot answers anyone with their
own Telegram id and runs no commands at all. Open `t.me/nitin_manager_bot`, send it
anything, and it replies:

```
🔑 Setup mode — this bot has no operators yet.

Your Telegram ID:
5332135237
```

Put that id in `bots/bot-nitin/config.json` and restart:

```json
"allowedTelegramIds": [5332135237],
```

```bash
pm2 restart bot-nitin
```

Setup mode ends the moment the list is non-empty. Anyone not on it is then ignored in
silence — the bot never reveals it exists.

> **Only add ids you want holding the kick command.** On bot-nitin, Telegram drives the
> live socket: `kick 9855112233` from Telegram really removes that person from all 12
> groups. That is the whole reason for this design, and it is also why the list is short.
>
> Your id is the same number on every bot, so it is one of the two already in
> `bots/bot-abhi/config.json` — but I did not guess which one is yours rather than Abhi's,
> so message the bot and read it off.

### 4. Check it

Send the bot `ping`, then `summary`. Expect the log to show both channels from one process:

```
🚀 bot-nitin — Member Management Bot
   Transport: dual
✅ Telegram: @nitin_manager_bot — 1 operator(s)
✅ Connected to WhatsApp
```

Then try `find <someone>`, and a real `add` / `kick`.

**`dmlist` is better on Telegram than on WhatsApp** — the `wa.me` links render as tappable
links right in the app, so your daily round is: run `dmlist` in Telegram, tap each link,
hit send.

### Rolling back

Comment the token out and restart. Ten seconds, and nothing else changes:

```bash
sed -i 's/^TELEGRAM_TOKEN=/#TELEGRAM_TOKEN=/' bots/bot-nitin/.env && pm2 restart bot-nitin
```

---

## Part 2 — Cloud API (needs a spare number; 1–3 days)

### 0. The number — read this first

A number registered on the Cloud API is **permanently removed from the WhatsApp app** and
**cannot be in any group**. So it can be neither:

- your personal number, nor
- the bot-nitin Baileys number (it must stay in the 12 groups).

It needs a **third number**, which receives one OTP and is then never touched again. Any
cheap prepaid SIM works — it does not need data or an active plan after verification.

### 1. Meta onboarding

1. Create a **Meta Business account** → `business.facebook.com`.
2. At `developers.facebook.com`, create an app of type **Business**, then add the
   **WhatsApp** product. This creates a WhatsApp Business Account (WABA).
3. **Register the spare number** to the WABA and verify it by OTP.
4. Start **Business Verification**. Unverified accounts cap at ~250 business-initiated
   conversations per day — well above your ~22/day — so **the cutover is not blocked on
   it**. Start it anyway; the cap tightens over time without it.
5. Add a **payment method**. Utility messages in India are cheap; the estimate in the code
   is ~₹90/month at ~22 due members a day. **Check the current India utility rate on
   Meta's pricing page before funding** — it has changed twice, and I am not going to quote
   a number that may be stale.
6. Create a **System User** and issue a **long-lived token** with `whatsapp_business_messaging`.
   **Do not use the temporary token from the app dashboard — it expires in 24 hours and the
   bot will silently stop reminding.**

### 2. Submit four templates

Category **Utility** for all four (payment/account update). *Not* Marketing — far pricier
and much easier to get blocked. Bodies come from `bots/bot-nitin/config.json` → `messages`,
with `{name}` → `{{1}}` and `{date}` → `{{2}}`:

| Template name | From | Params |
|---|---|---|
| `renewal_due` | `messages.reminder` | `{{1}}` name, `{{2}}` date |
| `renewal_due_referral` | `messages.referralReminder` | `{{1}}` name, `{{2}}` date |
| `renewal_overdue` | `messages.overdue` | `{{1}}` name, `{{2}}` days |
| `renewal_final` | `messages.finalReminder` | `{{1}}` name, `{{2}}` days, `{{3}}` date |

Those names are already in `config.json` under `cloudApi.templates` — name them exactly
this at Meta, or change the config to match.

Two things about the text:

- **Submit under language code `en`.** The bodies are Punjabi written in Latin script.
  Meta reviews the content, and a Gurmukhi `pa` submission will not match.
- **Add a line telling members to reply on the old number.** The reminder arrives from the
  new API number, which nobody is watching. Something like
  *"Reply on 9XXXXXXXXX for any help"* with the Baileys number.

Give `renewal_due` and `renewal_due_referral` an **image header** for the UPI QR.

### 3. Host the QR

Template headers need a fetchable URL — the inline attach that Baileys does is not
available. Upload `bots/bot-nitin/qr-payment.jpg` anywhere static and public, then put the
URL in `config.json`:

```json
"headerImageUrl": "https://.../qr-payment.jpg"
```

No code involved. Keep that URL alive — a dead link makes Meta reject the send.

### 4. Fill in the config

`bots/bot-nitin/.env` — the token, because `.env` is gitignored:

```
CLOUD_API_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`bots/bot-nitin/config.json` — the `cloudApi` block is already there; fill the two blanks:

```json
"cloudApi": {
  "phoneNumberId": "123456789012345",
  "headerImageUrl": "https://.../qr-payment.jpg",
  ...
}
```

`phoneNumberId` is on the WhatsApp → API Setup page. It is **not** the phone number.

### 5. Test before switching anything on

```
cloudapi test 9XXXXXXXXX
```

Use a number you can check. It reports the message id on success, or Meta's exact error.
**Reminders are still manual at this point** — `reminderChannel` is not set yet, so nothing
is automatic and this changes nothing about your daily round.

### 6. Throw the switch

Add one line to `bots/bot-nitin/config.json`:

```json
"reminderChannel": "cloudapi",
```

```bash
pm2 restart bot-nitin
```

That single flag wakes all three crons (6:30, 7:30, 10:00) and takes over from the group
digest. From now on reminders are private, automatic, and leave from Meta's API.

**Watch the next 6:30 AM run.** You should get a Telegram message like:

```
⏰ Reminder batch 1 — 22 sent, 0 failed

📨 Reminders today (14-08-2026) — 22 sent, 0 failed

✅ Gurpreet 9855112233  wamid.HBgMOTE5ODU1MTEyMjMz…
✅ Jaspal 9814556677 (ref ₹45)  wamid.HBgMOTE5ODE0NTU2Njc3…
...
```

Cross-check the count against `due` the same morning.

**Rollback:** delete the `reminderChannel` line and restart. Reminders go back to manual
`dmlist` and every gate closes again.

---

## How you know reminders are actually going out

You will not see them — they leave from a number that is not on your phone. So:

- **A Telegram report after every batch**, listing each member with Meta's `wamid` and each
  failure with Meta's own reason and code. That chat is your permanent, dated record.
- **`sent`** — same list on demand, any time, from today's `reminder-state.json`.
- Failures name the cause, and the code is what tells you whether *you* have to act:

| Code | Means | Do |
|---|---|---|
| `131026` | that number isn't on WhatsApp | one bad number — fix the sheet |
| `190` | token expired or revoked | re-issue the System User token |
| `132001` | template not found / not approved | check the name and approval state |
| `131047` / balance errors | account or funding problem | top up |

Ten failures in a row trip the circuit breaker, so a dead token costs 10 wasted calls, not
22 — and the report tells you which it was.

**What this does *not* prove:** that the member's handset received or read it. A `wamid`
means Meta accepted and will deliver. True delivered/read receipts need a webhook (below),
which is deliberately left for later so the cutover never waits on infrastructure.

**A Cloud API failure never falls back to a Baileys DM.** The failures that actually happen
— dead token, empty balance — fail for *everyone at once*, so a fallback would fire a full
batch of exactly the ban-triggering traffic this channel exists to avoid, at the worst
possible moment. Failed members are reported; you send those few with `dmlist`.

---

## What a ban costs you now

If the Baileys number gets flagged (403), the process stays up and:

| Still works | Gone |
|---|---|
| Every sheet command over Telegram — `add`, `renewed`, `find`, `status`, `summary`, `revenue`, `due`, `dmlist` | `kick`, `kickall`, `approve`, `groupcheck`, `kickghosts` — anything touching a group |
| Cloud API reminders (once Part 2 is done) — they never touch the socket | |
| The watchdog alert telling you it happened, relayed over Telegram | |

Every reply carries a banner while the socket is down, so you are never guessing:

```
⚠️ WhatsApp is DISCONNECTED — sheet commands work, group actions do not.
   Anything below about groups did not happen. Do it by hand in WhatsApp.
```

`add` still writes the sheet row and `kick` still marks REMOVED — the record stays right,
and you do the group half by hand. That is deliberate: the sheet is the part that matters.

**Do not rescan a flagged number.** Reconnects halt on purpose; repeatedly re-linking
escalates a temporary restriction toward a permanent ban. See `BAN-SAFETY-GUIDELINES.md`.

---

## Later: delivery receipts (not built)

The only thing that gives true per-member proof. Left for after the cutover has run clean:

- A **Cloudflare Tunnel** (free, no domain, no open port) in front of the existing express
  server on port 3010 — Meta needs valid HTTPS, which plain 3010 is not.
- `GET/POST /webhook` with the hub-challenge handshake and `X-Hub-Signature-256`
  verification, since the endpoint is public.
- Meta posts `sent → delivered → read → failed` per message id; match on the `wamid`
  already stored in `reminder-state.json` and stamp the status on.
- Then `sent` reads `22 sent · 22 delivered · 18 read · 0 failed`.
- **Bonus:** replies members send *to the API number* currently vanish. The same webhook
  receives them and can forward each to Telegram.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `config.json asks for "dual" but TELEGRAM_TOKEN is not set` | Expected before Part 1 step 2. Running WhatsApp-only, no backup channel. |
| Bot replies "Setup mode — this bot has no operators yet" | Expected before Part 1 step 3. Put your id in `config.json` and restart. |
| Bot ignores you completely on Telegram | Your id isn't in `allowedTelegramIds`. `pm2 logs bot-nitin` and look for the `🔑 Unauthorized` line. |
| `Another process is polling this bot token` | Two copies running. `pm2 list` — one is stale. |
| `Telegram token rejected` | Bad or revoked token. Re-issue with `/token` in @BotFather. **WhatsApp is unaffected** and keeps running. |
| A command says "connection is DOWN" | The Baileys socket is dead. `pm2 logs bot-nitin` — a 403 means the number is flagged. |
| `cloudapi test` says "not configured" | Missing `phoneNumberId` in `config.json` or `CLOUD_API_TOKEN` in `.env`. |
| Reminders didn't go out and `sent` is empty | `reminderChannel` isn't `"cloudapi"` yet — they're still manual. Run `dmlist`. |
