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

### Everything except the OTP can be done BEFORE the SIM arrives

The only step that genuinely needs the new number is registering it. In particular:

- **Templates belong to the WABA, not to a phone number.** Submit them now, get them
  approved now, and they are waiting when the number lands. Approval is the other thing
  with a queue, so doing it in parallel with the SIM saves days.
- **Meta gives you a free test number** the moment you add the WhatsApp product. It has its
  own `phoneNumberId` and can message up to 5 recipient numbers you verify. That is enough
  to run `cloudapi test` against your own phone and see the real Punjabi text with the QR
  header, end to end, before the SIM exists.

So the order is: do steps 1–5 now → SIM arrives → register it → change ONE value in
`config.json` → test again → flip the flag.

> Meta's console gets rearranged every few months, and my knowledge has a cutoff. Menu
> names below may have moved; the *shape* of the flow is stable. If a step doesn't match
> what you see, tell me what is on screen and I'll work from that.

### 1. Meta Business account

Go to `business.facebook.com` and create a Business account (needs a personal Facebook
login — the account is only an owner handle, nothing gets posted). Give it the real
business name you want members to eventually see.

### 2. Business verification — start it now, it is not a blocker

This is the long pole: documents, then a review queue.

Meta wants a legal business name + address, and documents proving both. In India that is
usually a **GST certificate** or **Certificate of Incorporation / Shop & Establishment
licence**, plus something showing the same name and address (**bank statement** or
**utility bill**). A business email on your own domain and a website help.

**You do not need this to go live.** Unverified, you get ~250 business-initiated
conversations per 24h — your volume is ~22–31/day, so it is roughly 8× headroom. Verification
raises the ceiling and is needed for a display name, not for sending. Start it, then carry
on with the rest; if you have no business documents, skip it entirely and revisit later.

### 3. Create the app and get the free test number

At `developers.facebook.com` → create an app of type **Business** → add the **WhatsApp**
product. This gives you a WhatsApp Business Account (WABA) and a **test number**.

On the WhatsApp → API Setup page, note:
- the **test number's `phoneNumberId`** (a long digit string — *not* a phone number)
- the **"To"** field, where you add up to 5 verified recipient numbers. **Add your own
  phone here** so you can receive test sends.

**Remember which WABA this is.** When the SIM arrives, add it to this *same* WABA so the
approved templates apply to it.

### 4. Submit four templates

Category **Utility** for all four (payment/account update). *Not* Marketing — far pricier
and much easier to get blocked.

**Two hard rules the code depends on:**

1. **Exactly two variables in every template: `{{1}}` = the member's name, `{{2}}` = a
   date.** The code sends two body params to all four. Meta answers `132000` on any
   mismatch, and it cannot see how many variables your approved template has, so this is
   a contract you have to hold up. (Locked by a test — see `tests/cloudapi-reminders.test.js`.)
2. **Every template needs an IMAGE header.** `cloudApi.headerImageUrl` is applied to every
   send, so a template without a header is rejected. Upload the UPI QR as the sample image
   on all four.

Also: **never start or end the body with a variable** — Meta rejects that. All four below
open with "Sat Sri Akal", so they are fine.

Submit under language **English (`en`)**. The text is Punjabi in Latin script; Meta reviews
the content, and a Gurmukhi `pa` submission will not match what you paste.

Names must match `cloudApi.templates` in `config.json` exactly:

**`renewal_due`** — header: IMAGE (the QR) · body:

```
Sat Sri Akal {{1}} paaji 🙏🏻
Aaj {{2}} nu tohada ik mahina pura ho gya
iss mahine lyi iste 90 pay krdo ji 🙏🏻
Kise vi help lyi 94641-80617 te reply kro ji
```

**`renewal_due_referral`** — header: IMAGE · body:

```
Sat Sri Akal {{1}} paaji 🙏🏻
Aaj {{2}} nu tohada ik mahina pura ho gya
Tusi ik banda add kraya si, iss lyi iste sirf ₹45/- pay krdo ji 🙏🏻
Kise vi help lyi 94641-80617 te reply kro ji
```

**`renewal_overdue`** (the day-5 nudge) — header: IMAGE · body:

```
Sat Sri Akal {{1}} paaji 🙏🏻
🚨 Aaj {{2}} — renew krke dss deyo ji 🙏🏻
Kise vi help lyi 94641-80617 te reply kro ji
```

**`renewal_final`** (day before removal) — header: IMAGE · body:

```
Sat Sri Akal {{1}} paaji 🙏🏻
Hnji veerji knra ji renew? Aaj {{2}} last date aaji 🙏🏻
Kise vi help lyi 94641-80617 te reply kro ji
```

**Edit the wording however you like — just keep `{{1}}` and `{{2}}`, in that order, neither
first nor last.** Your existing `messages.overdue` and `messages.finalReminder` had only one
variable and none at all, which is why these two gained a date.

The last line matters: the reminder arrives from the **new API number, which nobody
watches**. Without it, a member replying gets silence. Put the Baileys number there (change
`94641-80617` if that's not the one you want them messaging).

**Sample values.** Meta asks for one example per variable before it will submit. Use
`Gurpreet` for `{{1}}` and `15 Aug` for `{{2}}` — `{{2}}` renders like `5 Mar`, no year.

### 5. Host the QR, and get a permanent token

**The QR.** Template headers need a fetchable public URL — the inline attach Baileys does is
not available here. Upload `bots/bot-nitin/qr-payment.jpg` anywhere static and public and
put the URL in `config.json` → `cloudApi.headerImageUrl`. It must be plain `https`, no
login, `.jpg` or `.png`. A GitHub repo's raw URL, Cloudinary, or any static host is fine.
**Keep it alive** — a dead link fails every send, and a *changed* QR silently sends members
the wrong payment target.

**The token.** In Business Settings → Users → **System Users**, create a system user, give
it access to the WhatsApp app, and generate a token with `whatsapp_business_messaging` and
`whatsapp_business_management`. Choose **never expires**.

> **Do not use the temporary token on the API Setup page.** It dies in 24 hours, and when it
> does the bot stops reminding and you find out from a `190` in the Telegram failure report.

Then, on the VPS, in `bots/bot-nitin/.env` (gitignored, so it never reaches GitHub):

```
CLOUD_API_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

And in `bots/bot-nitin/config.json`, fill the two blanks — for now with the **test**
number's id:

```json
"cloudApi": {
  "phoneNumberId": "123456789012345",
  "headerImageUrl": "https://.../qr-payment.jpg",
  ...
}
```

`pm2 restart bot-nitin` after either file changes.

### 6. Prove the whole pipeline works — on the test number

```
cloudapi test 9XXXXXXXXX
```

Send it to **a number you added to the test number's recipient list** (your own). Expect the
QR image, the Punjabi text with your name and a date filled in, and a message id back.

Check it looks right on the handset: the QR renders, `{{1}}`/`{{2}}` came out as a real name
and date, and the "reply on …" line shows the number you want.

**Reminders are still manual at this stage.** `reminderChannel` is not set, so nothing runs
on a timer and your daily `dmlist` round is unchanged. Nothing you do here can send a
message to a real member — the test number physically cannot reach anyone outside those 5.

If it fails, the error tells you which rule you broke:

| Error | Meaning |
|---|---|
| `132000` | param count mismatch — your template doesn't have exactly two variables |
| `132001` | template name not found, or not approved yet, on this WABA |
| `132012` | component mismatch — usually a missing IMAGE header on the template |
| `131030` | recipient not in the test number's allowed list |
| `190` | token expired — you used the temporary one |

### 7. When the SIM arrives

This is the whole handover, and it is one value:

1. Add the new number to the **same WABA** (WhatsApp → API Setup → add phone number) and
   verify by OTP. Your four templates are already approved on that WABA and apply to it.
2. Copy its **new `phoneNumberId`** and replace `cloudApi.phoneNumberId` in `config.json`.
3. `pm2 restart bot-nitin`, then `cloudapi test <your own number>` again — this time it can
   reach any number, not just the five.
4. Only then, step 8.

Keep the SIM in a phone and reachable until the OTP is done. Afterwards the number is
API-only: it will not work in the WhatsApp app and cannot be added to any group.

### 8. Throw the switch

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
