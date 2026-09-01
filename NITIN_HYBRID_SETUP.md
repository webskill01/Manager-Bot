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

- **Templates are WABA assets, not phone-number assets.** Submit them now, get them approved
  now, and they are waiting when the number lands. Review takes **up to 24 hours**, so doing
  this in parallel with the SIM is free time.
- **Meta gives you a free test number** the moment you add the WhatsApp product, along with a
  pre-approved `hello_world` template. It has its own `phoneNumberId` and sends **free**
  messages to up to **5 recipient numbers** you verify. That is enough to run `cloudapi test`
  against your own phone and see the real Punjabi text with the QR header, end to end,
  before the SIM exists.

So the order is: do steps 1–6 now → SIM arrives → register it → change ONE value in
`config.json` → test again → flip the flag.

> **Verified against Meta's docs, August 2026.** The facts below (test number + 5 recipients,
> 24h template review, 250/day starting limit, portfolio-level limits) come from the current
> documentation — links at the bottom of this file. The console's menu names still drift; if
> a step doesn't match your screen, work from the shape, not the wording.

### Status as of 2026-08-15

Done: Meta Business account · app `WS Group Reminder` · WABA `2818177488551937` · test number
`+1 555 633 6574` with Phone Number ID `1336660736191431` · own number verified as a test
recipient · `hello_world` received · **all four templates submitted, all as Utility**.

Still open, in the order they block things:

1. **Billing** — the Visa debit card was declined. This is a HARD gate: no payment method
   means no business-initiated messages, so nothing can go live without it. Try a credit card,
   or UPI / net banking in the Billing Hub.
2. **Permanent access token** — the console's Generate button demanded an SMS code that never
   arrived (it wants 2FA on the Facebook/Business account, nothing to do with WhatsApp). Use
   the manual route instead: Business Settings → Users → **System users** → add user → assign
   the WhatsApp app → Generate token → never expires. See step 5.
3. **The SIM** — the only thing that genuinely cannot be done in advance.

Nothing is wired into the bot yet: `cloudApi.phoneNumberId` is still `""` and
`reminderChannel` is unset, so reminders remain manual `dmlist`.

### 1. Meta Business account

Go to `business.facebook.com` and create a Business account (needs a personal Facebook
login — the account is only an owner handle, nothing gets posted). Give it the real
business name you want members to eventually see.

### 2. Business verification — SKIP IT for now

Checked the numbers, and verification buys you nothing you need:

| | Unverified | Verified |
|---|---|---|
| Messages/24h to unique users | **250** | 1,000 |
| Templates per WABA | 250 | 6,000 |

Your real volume is **~22–31 reminders a day** and you need **4 templates**. So unverified
gives roughly 8× the sending headroom and 60× the templates you'll ever use.

Since October 2025 these limits are set **per business portfolio**, not per phone number, and
they scale automatically — but only if you use at least half your current limit within 7
days, which at 30/day you never will. That is fine: you sit at 250 forever and never notice.

So: **don't chase verification.** If you later want it (it needs a legal business name and
address, proven by a GST certificate or Certificate of Incorporation plus a matching bank
statement or utility bill), it can be done any time without touching the bot. Nothing in
this setup depends on it.

### 3. Create the app and get the free test number

At `developers.facebook.com` → create an app of type **Business** → add the **WhatsApp**
product. In **API Setup** you'll be asked to connect a WhatsApp Business Account — you can
select an existing one or **create a new one**. Create one, and **write down which WABA it
is**: when the SIM arrives you add the real number to *this same WABA*, and your approved
templates come along with it.

On the API Setup page, note:
- the **test number's `phoneNumberId`** — a long digit string, *not* a phone number
- the **"To"** field: add up to **5 recipient numbers**. **Put your own phone here** so you
  can receive test sends. Sends to these are free.

You'll also see a **temporary access token** here. Ignore it — see step 5.

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

**Leave "Set custom validity period" UNTICKED.** The form warns that "the standard 10 minutes
WhatsApp message validity period will be applied" — that is the **authentication** default and
the console is showing it on the wrong form. For **utility** the real default is **30 days**,
and the custom field can only make it *shorter* (30 s – 12 h max). Ticking it and choosing the
maximum 12 hours would cut a 30-day delivery window down to twelve hours.

This matters because TTL governs **delivery to the device, not reading**. Once WhatsApp hands
the message to the handset the clock stops and it sits in the chat indefinitely — a member who
doesn't open WhatsApp for three days still has it waiting. TTL only expires for a phone that is
off or out of coverage for the whole window, and at 30 days that is nobody. A message dropped
on TTL is never charged and never seen, and you only learn it happened from a *missing*
delivery webhook — which is not wired yet, so an expiry today would be invisible.

Submit under language **English (`en`)**. The text is Punjabi in Latin script; Meta reviews
the content, and a Gurmukhi `pa` submission will not match what you paste.

Names must match `cloudApi.templates` in `config.json` exactly:

These are the exact bodies that **passed as Utility** on the live console. They are not
drafts — every one was accepted. If you reword them, read the classifier section below first.

**`renewal_due`** — header: IMAGE (the QR) · body:

```
Sat Sri Akal {{1}} paaji 🙏🏻

Tohadi Punjab Taxi Group di monthly membership di payment pending hai.
Status: due on {{2}}
Renewal due: ₹90

Iss mahine lyi upar ditte QR te payment karke dss deyo ji 🙏🏻
Sada saath bnaye rakho ji — kise vi help lyi 9464180617 te msg krdeyo ji
```

**`renewal_due_referral`** — header: IMAGE · body. "Adhi payment" (half) instead of a second
figure, so a member who earned the discount knows they owe less without the template carrying
two different amounts:

```
Sat Sri Akal {{1}} paaji 🙏🏻

Tohadi Punjab Taxi Group di monthly membership di payment pending hai.
Status: due on {{2}}
Tusi ik banda add kraya si, iss lyi is mahine adhi payment hi banda hai.
Upar ditte QR te payment karke dss deyo ji 🙏🏻

Kise vi help lyi 9464180617 te msg krdeyo ji
```

**`renewal_overdue`** (the day-5 nudge) — header: IMAGE · body. **No amount on purpose**:
referral members owe ₹45 not ₹90 and this template goes to both, so any figure would be wrong
for some of them:

```
Sat Sri Akal {{1}} paaji 🙏🏻

Hnji Veerji Krna ji Renew ? Tohadi Punjab Taxi Group di monthly membership di payment pending hai.
Status: overdue as of {{2}}
Upar ditte QR te aaj payment karke dss deyo ji 🙏🏻

Kise vi help lyi 9464180617 te msg krdeyo ji
```

**`renewal_final`** (day before removal) — header: IMAGE · body:

```
🚨🚨 SSA {{1}} paaji

Tohadi Punjab Taxi Group di monthly membership di payment hun tak pending hai.
Status: last date {{2}}
Aaj last date aa ji, payment krke niche ditte number te msg krdeyo ji 🙏🏻

Kise vi help lyi 9464180617 te msg krdeyo ji
```

**Edit the wording however you like — just keep `{{1}}` and `{{2}}`, in that order, neither
first nor last.** Your existing `messages.overdue` and `messages.finalReminder` had only one
variable and none at all, which is why these two gained a date.

The last line matters: the reminder arrives from the **new API number, which nobody
watches**. Without it, a member replying gets silence. Put the Baileys number there (change
`94641-80617` if that's not the one you want them messaging).

### Getting Utility past the category classifier

Meta's pre-submit classifier recommends **Marketing** on a renewal reminder and warns "this
message template will be rejected". Marketing is the wrong answer: it is not mainly the ~7×
price, it is that marketing templates hit **per-user frequency caps**, so Meta silently drops
some of them while the API still returns a `wamid` that looks like success. A renewal system
that quietly skips members is worse than a dear one. Marketing also carries opt-out and a
heavier quality-rating hit when reported.

Established on the live console, Aug 2026, by changing one thing at a time. **Two things
matter, and neither is the price:**

**1. Address the member by name.** `{{1}}` in the greeting. This alone flipped the final
notice from Marketing to Utility with nothing else changed. A named person plus an account
status reads transactional; a generic "Paaji" broadcast reads promotional.

**2. Frame it as a payment that is PENDING on an existing account** — not as a billing cycle
that has completed. This was the whole fight:

| Body shape | Verdict |
|---|---|
| `payment pending hai` + `Status: overdue as of {{2}}` | **Utility** |
| `payment hun tak pending hai` + `Status: last date {{2}}` | **Utility** |
| `payment pending hai` + `Status: due on {{2}}` | **Utility** |
| `ik mahina {{2}} nu pura ho gya hai` ("your month is complete, now pay") | **Marketing** |

"Your month is up, please pay" reads as soliciting a NEW purchase cycle. "Payment is pending,
status: due on <date>" is an account statement. Same intent to you, completely different shape
to a classifier.

Two structural habits that come with it: keep `Status: … {{2}}` on **its own line** (a labelled
status field reads like a statement, not prose), and keep the words `membership`, `payment`,
`pending`, `Status`, `due` in the body.

**Ruled out, so nobody wastes time retrying them:** the rupee amount is NOT the trigger — a
version with no figure at all was still flagged while the reframed version with `Renewal due:
₹90` passed. Rewriting the body in plain English does not help either (the classifier is not
failing on Latin-script Punjabi), and removing the QR image header does nothing.

If a template is rejected outright, **do not appeal — submit a new version** with the pending
framing. That is days faster than Business Support Home.

**Re-check the category badge in WhatsApp Manager after approval.** Meta re-categorises
templates on its own based on content, and a silent flip to Marketing shows up as a 7× bill
and dropped messages, never as an error.

**Sample values.** Meta asks for one example per variable before it will submit. Use
`Gurpreet` for `{{1}}` and `15 Aug` for `{{2}}` — `{{2}}` renders like `5 Mar`, no year.

### 5. Host the QR, and get a permanent token

**The QR.** Template headers need a fetchable public URL — the inline attach Baileys does is
not available here. Upload `bots/bot-nitin/qr-payment.jpg` anywhere static and public and
put the URL in `config.json` → `cloudApi.headerImageUrl`. It must be plain `https`, no
login, `.jpg` or `.png`. A GitHub repo's raw URL, Cloudinary, or any static host is fine.
**Keep it alive** — a dead link fails every send, and a *changed* QR silently sends members
the wrong payment target.

**The token.** In Business Settings → Users → **System Users**, create a system user, give it
access to the WhatsApp app, and generate a token with **never expires** and these permissions:

```
whatsapp_business_messaging     ← sending
whatsapp_business_management    ← templates
business_management
```

> **Do not use the temporary token on the API Setup page.** Meta's own docs call it "not
> suitable for development purposes" — it expires within hours, and when it does the bot
> stops reminding and you find out from a `190` in the Telegram failure report.

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

If `cloudapi test` comes back `132001` (template not found) after the swap, the real number
went onto a *different* WABA than the templates. Move the number, or re-submit the four
templates on the WABA it actually landed on.

### 7b. What it will cost — add a payment method

Read the rate yourself; I could not extract it. Meta puts India's utility rate behind an
interactive selector and a downloadable rate card, current rates **effective 1 July 2026**:

- `business.whatsapp.com/products/platform-pricing` → pick **India**, currency **INR**,
  category **Utility**
- or the rate-card CSV/PDF linked from `developers.facebook.com/docs/whatsapp/pricing`

Then the arithmetic is just:

```
monthly ≈ rate_per_utility_message × 31 × 30       ≈ rate × 930
```

31/day is your worst case (due + day-5 + final on a busy day); ~22/day is typical. At the
₹0.115 the code comments assume, that is roughly **₹105/month** — but **verify the rate**,
because India's marketing rate rose on 1 Jan 2026 and the authentication-international rate
on 1 Apr 2026, so the numbers in this repo's older notes may be stale.

**Assume every reminder is billed.** Utility templates are free only inside an open 24-hour
customer service window — i.e. when the member messaged *that* number first. Your templates
point replies at the Baileys number on purpose, so no window ever opens on the API number and
nothing is free. That is the right trade: it is the Baileys number that must keep the
conversation, and ~₹100/month is the entire point of this exercise.

Volume tiers exist but start far above your scale — ignore them.

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

## The shared revenue ledger (added 24 Aug 2026)

One spreadsheet, four bots, no spreadsheet visits. Each bot appends its own daily row and
your own formulas turn those counts into money.

**Two tabs.** `LOG` is what the bots write — one `(DATE, BOT, NEW, RENEWED)` row per bot per
day, created automatically on first run. `SUMMARY` is yours: one row per date, every figure a
`SUMIFS` over LOG. `scripts/setup-ledger-sheet.js` builds it (372 rows, a year ahead) and
refuses to overwrite existing rows without `--force`.

**When it writes.** 10 PM captures the day while it is still the day. 6 AM the next morning
recomputes every date back to `startDate` and rewrites only the rows that DIFFER — that one
pass is the correction (anything you logged after 10 PM), the backfill, and the self-heal for
a bot that was offline. Steady state it writes one row or none.

**Setup per bot.** In `bots/<bot>/.env` — never `config.json`, this repo is public:

```env
LEDGER_SHEET_ID=<the shared sheet id — the SAME on all four bots>
```

Share that sheet as **Editor** with the service account in `service-account.json`
(`client_email`). All four bots use the same one, so it is a single share, not four.

`config.json` carries layout only:

```json
"ledger": {
  "tab": "LOG",
  "startDate": "17-08-2026",
  "summaryTab": "SUMMARY",
  "summaryColumns": { "From friends' bots": "J", "Total per person": "L" }
}
```

`summaryTab` and `summaryColumns` are **bot-nitin only**. They make its `summary`, `revenue`,
`weekly`, `monthly` and `digest` end with the group's figures, read back from your SUMMARY
tab. The friend bots have neither, so each keeps reporting only its own money — their
operators must not see the group total.

**Checking it.** A healthy bot says so at boot:

```bash
grep 📒 logs/bot-nitin-out.log
# 📒 Ledger ON → "LOG" tab, since 17-08-2026
```

A bot missing the id says `📒 Ledger configured but DISABLED` and names the exact `.env`.
`git pull` cannot deliver `.env`, so this is the step that gets forgotten on a new box.

**Commands.** `ledger` (status), `ledger now` (write today), `ledger sync` (backfill and
correct everything since `startDate`). Or `node scripts/ledger-backfill.js` for bots that are
not running — it forks a child per bot, because `loadConfig()` copies each `.env` into
`process.env` and never overwrites, so a loop in one process would read the FIRST bot's sheet
under the first bot's name and report success.

**Two traps already paid for.** `LOG` is also a Sheets function, so every tab reference in a
generated formula must be quoted (`'LOG'!$C:$C`) or SUMIFS returns `#N/A`. And SUMMARY's DATE
column must stay TEXT — the bots write `DD-MM-YYYY` text and SUMIFS only matches text against
text; let Sheets turn it into real dates and every formula silently returns 0.

**Why counts and not rupees.** Fees, renewal amounts and the split live in your sheet's
formulas. If the bots wrote money too there would be two answers to "what did we earn on the
3rd" the first time a price changed.

---

## Until the Cloud API is live: the drip

Cloud API is blocked on billing, so reminders do not go through Meta. The drip removes the part
you kept getting wrong — remembering — without touching the part that keeps you safe.

**Auto since 01 Sep 2026.** At 6 AM a `drip-arm` cron builds the day's four queues (due today,
day-5, day-6, and the missed backlog) and the bot then sends them itself over its own linked
device until 6 PM. Both crons and the first send carry jitter, so nothing lands at a time
anyone could set a watch by: `drip-arm` fires 06:00–06:20, and the day's first message goes out
up to 40 minutes after that.

The pacing is exactly what the thumb was doing before, because that is the cadence that was
verified working for a week after the restriction lifted:

- **three per batch** — one member from each cohort, same as the links it used to push
- **40–180 s between the messages of a batch**, on top of a per-message typing simulation
- **≥18 min between batches**, stretched to fill the window so a light day is not front-loaded
- the account goes back to **offline / "last seen at"** after each batch instead of sitting
  online all day

```json
"dripIds": ["5332135237"],
"drip": {
  "mode": "auto", "startHour": 6, "endHour": 18,
  "gapMinMs": 1080000, "gapMaxMs": 1500000,
  "gapCapMs": 7200000, "firstDelayMaxMs": 2400000
}
```

Optional knobs, all defaulted: `batchSize` (3 — set 1 for the old one-at-a-time behaviour),
`msgGapMinMs` / `msgGapMaxMs` (40000 / 180000).

Anything the bot cannot send it hands back to you as a tap-to-send link, and five failures in a
row hand over the whole rest of the day. `drip stop` ends it.

`dripIds` is who gets buzzed — deliberately **not** `allowedTelegramIds`, which stays as the
command allow-list so Tanishq keeps command access and the digests without ~34 buzzes a day.

| Command | Does |
|---|---|
| `drip` | what's been pushed today, what's left, and whether it's running |
| `drip test` | pushes one real batch **now**, ignores the window, **records nothing** — those members still get their real push later |
| `drip stop` / `drip start` | pause for the day / resume |

Behaviour worth knowing:

- The sheet is re-read before **every** push, so anyone who pays mid-day drops off the rest of
  the queue. `markPhoneReminded` is honoured too — a manual `dmlist` earlier won't double-hit.
- Whatever isn't reached by 9 PM is **dropped, not carried**. Those members arrive tomorrow one
  day more overdue, which the 5/6/7 ladder absorbs. Carrying them is what lets a backlog snowball.
- At 9 PM you get "N pushed, M not reached". **If that report doesn't arrive, the drip died** —
  a dead drip and a quiet day look identical otherwise.
- `messages.reminder` and friends accept an **array** of wordings. Each member gets one picked
  from `hash(phone + today)` — random across members and months, stable within a day.

**When the Cloud API goes live, the drip is replaced, not run alongside it.** Flipping
`reminderChannel` wakes the three reminder crons; leave the drip armed and members would get
both. Set `drip stop`, or drop the `drip` block, on the same day you cut over.

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
| Card declined in the Billing Hub | Meta India rejects most debit cards (RBI rules on international recurring mandates). Use a credit card, or UPI / net banking. |
| "Generate token" wants an SMS code that never arrives | That's 2FA on your Facebook/Business account, not WhatsApp. Fix the number in Accounts Center, switch 2FA to an authenticator app, or bypass it with the System users route in step 5. |
| Template says "Category does not match … will be rejected" | Reframe as a pending payment — see the classifier section. Never lead with "your month is complete". |
| `132000` on every send after editing a template | The template's variable count drifted from two. Every template takes `{{1}}` name and `{{2}}` date — nothing else. |

---

## Sources

Part 2 was checked against Meta's live documentation in **August 2026**. Meta changes these
pages often — re-read them if something below stops matching reality.

- [Cloud API — Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/) — app creation, selecting or creating a WABA, the test number, the temporary token being unfit for real use
- [Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview) — templates are WABA assets; review takes up to 24h; templates are the only way to message a user outside a customer service window
- [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) — the 250/day starting limit, and 250 vs 6,000 templates for unverified vs verified portfolios
- [Upcoming messaging-limit changes](https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes/) — limits moved to a per-portfolio basis on 7 Oct 2025; scaling needs ≥50% of the limit used within 7 days
- [Configure message time-to-live](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live) — utility defaults to **30 days**, customisable only DOWN to 30 s – 12 h; the console's "10 minutes" warning is the authentication default shown on the wrong form
- [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) — per-message billing since 1 Jul 2025, rate cards effective 1 Jul 2026, utility free only inside an open customer service window, tiers aggregate at portfolio level
- [Platform pricing rate cards](https://business.whatsapp.com/products/platform-pricing) — the India/INR/Utility rate itself, behind the selector
