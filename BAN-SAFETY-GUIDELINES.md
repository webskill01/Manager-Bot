# WhatsApp Ban-Safety Guidelines — Manager Bot Operators

**Who this is for:** every friend operating a bot number (bot-nitin, bot-abhi, bot-sachin2, bot-aayush2).
**Why it exists:** three of our numbers got repeatedly temp-banned (403). Investigation showed the bans come from
WhatsApp's ML systems scoring **the number's trust, the IP it links from, and its sending behavior** — not from any
single bug. The bot now automates a lot of safety (jitter, spacing, warm-up, group digests), but the operator's
daily habits decide whether a number survives. Read this once, follow it always.

---

## 1. How WhatsApp decides to ban (know your enemy)

WhatsApp scores every account on four layers. Cross a threshold on any one → temporary restriction (403).
Repeat → permanent ban.

| Layer | What it measures | What kills us |
|---|---|---|
| **Registration fingerprint** | Device, IP, linking history | Linking from flagged VPS/datacenter IPs; re-scanning a just-banned number |
| **Behavior** | Send velocity, reply ratio, timing patterns | Payment DMs to people who never reply; bursts; robotic exact-time sends |
| **Reports & blocks** | How many recipients block/report you | Messaging strangers first; kicked members reporting; links to non-contacts |
| **Content patterns** | Message shape, links, forwards | Many invite links in one message; identical text to many people |

**Key facts learned the hard way:**
- **SIM age ≠ trust.** A months-old SIM with thin WhatsApp usage is "fresh" to WhatsApp. Trust = active chats,
  people who saved your number, group history, zero prior bans.
- **Every ban permanently lowers trust.** That's why bot-aayush2 now gets banned after replying to just 2–3 people —
  the number is burned. A number banned 3+ times should be replaced, not revived.
- **Replies to people who did NOT save your number** count worse. If they hit "Report spam" on your first message,
  it's a heavy strike.

---

## 2. Number & linking rules

### DO
- ✅ **Use the number like a human for 1–2 weeks BEFORE linking it to the bot** — real chats with real contacts
  who reply, a few statuses, join a couple of normal groups from the phone.
- ✅ **Get people to save the bot number.** Admins, family, and every new member ("save this number for duty
  updates"). Saved-contact rate is a direct trust signal.
- ✅ **Keep WhatsApp open on the physical phone** with occasional manual use. The bot is a *linked device*;
  a main phone that behaves normally keeps the account looking human.
- ✅ Link from the assigned clean VPS only (never Oracle free tier for a fragile number).
- ✅ Respect the bot's **warm-up mode** after a fresh link — 24–72h of silence is intentional. Don't ask for it
  to be disabled.

### DON'T
- ❌ **Never re-scan a QR right after a ban.** Reconnect-looping into a 403 escalates a temporary restriction
  toward a permanent ban (the bot now halts automatically — do not fight it).
- ❌ Never re-link a banned number before **2+ weeks** of rest AND an in-app appeal
  (WhatsApp → Settings → Help → Contact us / "Request a review").
- ❌ Don't run the bot number's WhatsApp on random devices/emulators.
- ❌ Don't use a number that was already banned 3+ times. It's dead. New SIM, start the warm-up protocol.

---

## 3. New-member onboarding — the safe version of our flow

Our flow: *person asks to join → we ask details → share links → send QR → payment received → direct-add to
2–3 paid groups OR approve their join request.* This flow is fundamentally good because **the member messages
first** — keep it that way. Rules per step:

### Step 1 — First contact
- ✅ **Always let THEM message first.** Replying to an incoming chat is the safest send that exists.
- ❌ Never cold-DM a number that hasn't messaged you ("bhai group join karna hai?"). One report = heavy strike.
- ✅ Ask them to **save your number** in this first conversation.

### Step 2 — Sharing group links

> **18 Aug 2026 — the bot no longer sends these. You do.**
> `add` and `sendlinks` used to fire 12 link messages plus a welcome at a fixed 1.2-second
> interval from the linked device. Nobody types 13 messages in 16 seconds, and that cadence —
> not the links themselves — is what reads as automation. Both commands now hand you
> **tap-to-send links**: tap, WhatsApp opens with the message already typed, hit send.
>
> bot-nitin's 12 groups arrive as **2 taps of 6 links each**, because WhatsApp hides anything
> past ~800 characters behind "Read more" and a single 12-link message would bury most of them.
> Send both parts; a 15–30 second gap between your taps is normal and fine.
>
> Invite codes are fetched **live** from the socket every time, so they are never stale after a
> ban and re-link. `groupLinks` is gone from config — there is nothing to update any more.
> Friend bots have no WhatsApp connection, so they cannot fetch codes at all: share those
> invites from your own phone.

- ✅ Share links **only inside an active chat** where they asked to join.
- ✅ 2–3 links in one message is OK for an interested person. Add a line of human text around the links,
  never a bare link-dump.
- ❌ Don't paste your invite links into other people's groups, status of strangers, or unrelated chats —
  invite-link spraying is a classic spam trigger.
- ❌ Don't re-send the same links again and again to someone who hasn't responded. Once, then wait.
- ❌ If a person never replies after links were sent, **stop**. Do not follow up more than once.

### Step 3 — Payment QR
- ✅ Send the QR in the same active conversation, after they agreed to pay. That's a reply, not spam.
- ❌ Don't blast the QR to people who went silent.

### Step 4 — Adding to paid groups
- ✅ **Prefer the invite-link → join-request → `approve` path.** When the member taps the link and requests to
  join, THEY initiated it — WhatsApp treats admin approval as completely normal. This is the safest add there is.
- ⚠️ **Direct add (`rejoin` / group add) is riskier**: if the person doesn't have your number saved, WhatsApp may
  block the add or flag it ("only contacts can add"). Use direct add only when the person has saved your number
  and is expecting it *right now*.
- ✅ Space it out: the bot already gaps group ops 8–12s and cools down between batches — never queue many adds
  back-to-back manually.
- ❌ **Never re-add someone who left or was removed, repeatedly.** Repeated adds of the same person is one of
  WhatsApp's explicit "spam behavior" patterns and invites a report. If they left, send ONE message asking if
  they want back in; let them use the link.
- ❌ Don't add more than **~10 new members per day per bot number** (fresh/re-linked numbers: max 3–5/day for
  the first month).

---

## 4. Group operations — kicks, approvals, cleanups

The bot's engines already pace these safely. Operator rules:

- ✅ `approve` / `approveall` — safe; members requested to join themselves. Use freely but not 10× in a minute
  (the bot dedupes anyway).
- ⚠️ `kick [phone]` — fine occasionally. Removing members is normal admin behavior, but **mass removal in a
  short window is heavily weighted**. For more than 2–3 removals, always use the engines:
- ✅ `kickall` (15–30 min per person) and `kickghosts` — designed to look human. **Never** ask for the gaps to
  be shortened, and don't restart the bot mid-run to "speed it up" (state resumes anyway).
- ⚠️ **Trial removal** (`start removal`) does batch kicks + a promo message + media in a free group. It's the
  single most aggressive thing we run. Never run it on a number that is fresh, re-linked, or has ANY prior ban.
  Established numbers only, and not on the same day as `kickall`.
- ❌ Don't run two heavy engines at once (kickall + kickghosts + trial together = burst pattern).
- ❌ Don't kick and re-add the same person as a "warning" — that pattern gets reported.

---

## 5. Reminders & bulk messages

The July 2026 rework exists because payment-demand DMs are our #1 ban signal. Rules:

> **27 Jul 2026 — no bot sends anything to anyone on a schedule any more.**
> A freshly linked number was banned the morning after warm-up expired: its first-ever
> outbound act was the 6 AM digest DMing three admins. "Group mode" was never the DM
> kill-switch it looked like — it gated only the daily batch and the day-5 nudge, while
> the morning digest, evening summary, day-6 final reminder and auto-renew notices all
> still went out as DMs. Every one of those paths is now closed:
>
> - `morning-digest` and `evening-summary` cron jobs **deleted**. Pull the same reports
>   on demand with the `digest` and `summary` commands.
> - Day-6 final reminder is **group-tagged** in group mode (a private version belongs on
>   the official Cloud API, where it cannot get the number banned).
> - The day-7+ removal list is no longer DM'd daily — run `removal` or `overdue`.
> - Auto-renew notices are logged and shown in `digest`.
> - `warmupHours` default raised 24 → 72.
>
> The only automated outbound left on a full-profile bot is one group message per group
> per day. Tracker-profile bots register **zero** cron jobs.

> **18 Aug 2026 — the digests are back, over Telegram only.**
> The rule above was never "these reports are dangerous", it was "the only way to deliver
> them was WhatsApp". Now that every bot has a Telegram operator channel, `morning-digest`
> and `evening-summary` run again — and a `drip-arm` job at 9 AM joins them. All three
> deliver through Telegram and **cannot** reach the WhatsApp socket: a bot with no Telegram
> token is passed no such task and therefore registers no such job.
>
> What has NOT changed: no bot sends anything to a **member** on a schedule. The drip pushes
> links to *you*; you send them. That distinction is the whole design.

> **01 Sep 2026 — bot-nitin only: the drip now sends by itself.** The line above still holds
> for the three friend bots, which have no socket and cannot do otherwise. bot-nitin is in
> `"drip": { "mode": "auto" }` and transmits over its own linked device, 6 AM-6 PM.
>
> The rate is unchanged from what the thumb was doing: three messages per batch, 40-180 s
> apart inside the batch, batches ≥18 min apart and stretched to fill the window. What is
> gone is the failure mode that caused BOTH bans — a stack of unseen Telegram pushes cleared
> by hand in one sitting. The bot cannot fail to notice its own timer.
>
> `drip stop` still ends the day, and five failed sends in a row hand the whole remaining
> queue back to you as links automatically.

- ✅ **Group reminder mode is the default for fragile numbers.** One tagged digest in the paid group replaces
  all cold DMs. Members are in that group by choice — near-zero report risk.
- ✅ **No message tags more than 20 people.** Larger lists split automatically and are spaced apart. Bulk
  @mentions are a spam signal in their own right — don't defeat this by pasting a long tag list by hand.
- ✅ `catchup [days]` after an outage — group messages only, one per renewal date, 8–12 min apart, and it
  grants 3 days grace so nobody is removed for downtime the bot caused. Preview first (no `confirm`).
- ✅ `remindall` — safe (group message). Still, don't fire it 5 times a day; 1–2 manual re-fires max.
- ⚠️ `remind [phone]` (manual DM) — only for members who reply to you and have your number saved.
- ⚠️ `warnall` — it DMs everyone on the removal list. The bot spaces it 5–15 min per person now. Use at most
  once per day, and prefer letting the group digest's overdue tags do the pressure instead.
- ❌ Never copy-paste the same reminder text manually to many members from the phone — that's the exact burst
  pattern the bot was rebuilt to avoid.
- ❌ Don't send reminders late at night (recipients report night-time business messages far more).

### The drip (18 Aug 2026) — the bot paces you, you still send

*On the friend bots.* On bot-nitin the same pacing now drives the bot's own socket — see the 01 Sep 2026 note
above; everything below about spacing, volume and catch-up still applies, it is just the bot obeying it.

Reminders are sent **by hand**, from your own phone, and that has not changed. What changed is that you no
longer have to remember. From 9 AM the bot pushes you up to three tap-to-send links per Telegram message,
every 18–25 minutes, until 9 PM.

- `drip` — what's been pushed today, what's left  ·  `drip test` — one batch now, records nothing
- `drip stop` — pause for the day  ·  `drip start` — resume

**Tap them as they arrive.** Ignoring six buzzes and then firing them all at once recreates the exact burst
this replaces — you'd be worse off than before, because now there are more of them. If you can't keep up,
`drip stop` is the correct answer, not a catch-up session.

**Read this honestly:** forgetting used to rate-limit you by accident. That safety net is gone. A full day is
roughly **53 messages** (~31 due + ~12 at day-5 + ~10 at day-6). If you were sending 20 a day before, this is
a deliberate step up in exposure, not a neutral convenience. The 18–25 min spacing and the wording variants
are what keep it safe — don't compress either.

- ✅ Anyone who pays mid-day drops off the remaining queue automatically. You never chase someone who settled up.
- ✅ Whatever isn't reached by 9 PM is **dropped, not carried**. They arrive tomorrow one day more overdue,
  which the 5/6/7 ladder absorbs. Don't try to catch up manually at 10 PM.
- ✅ At 9 PM you get "N pushed, M not reached" — if that report never arrives, the drip died. Check `drip`.
- ✅ Message wording can be an **array** of 2–3 variants in config; each member gets one picked from their
  phone number and the date. 929 people receiving identical text is a stronger spam signal than any gap
  setting can offset, so this matters more than the timing does.

---

## 6. What the bot already does for you (don't fight it)

| Protection | What it means for you |
|---|---|
| **No scheduled DMs to members, ever** | Timers push to your Telegram only. Nothing the bot runs on a schedule can reach a member's phone |
| **The bot never sends member-facing messages** | Reminders and group links are handed to you as tap-links. Every message a member gets came from your own thumb |
| **Live invite codes** | Fetched from the socket at send time — never stale after a ban, nothing to update in config |
| **Wording variants** | `messages.*` can be an array; each member gets one picked from their phone + the date, so 929 people don't receive identical text |
| **Cron jitter (0–20 min)** | The remaining reminder jobs fire at slightly different times daily — don't "fix" the timing |
| **Warm-up mode (72h default)** | Fresh links stay silent — wait it out. Only set `warmupHours: 0` on an established, healthy number |
| **403/401 halt** | After a ban the bot STOPS reconnecting — never delete auth and re-scan without the 2-week protocol |
| **Group digest mode** | Reminders without DMs — keep fragile bots in `"mode": "group"` |
| **20-mention cap** | Long tag lists split into spaced messages automatically |
| **DM spacing (5–15 min)** | The few remaining manual DMs (`remind`, `warnall`) trickle out — a "slow" bot is a healthy bot |
| **Engine gaps & cooldowns** | Kicks/adds are paced — don't restart pm2 to hurry them |
| **Sheets retry/backoff** | Rate limits pause and resume instead of crash-looping — a restart loop burns more quota |

---

## 7. If a ban (403) happens anyway

1. **Do nothing for 10 minutes.** Don't restart, don't re-scan. The bot has already halted.
2. Open WhatsApp on the phone → if it shows "account restricted", tap **Request a review** immediately.
   Reviews often lift temp bans in hours–days.
3. Tell the group owner (Nitin) which number and what the bot was doing in the last hour (check pm2 logs).
4. After the restriction lifts: **use the number ONLY on the phone for 1–2 weeks** (human chats, no bot).
5. Re-link following Section 2, from the assigned clean VPS, one number at a time (never all three the same week).
6. First week after re-link: replies only. No reminders, no adds, no kicks. Let the warm-up + slow ramp run.

---

## 8. The golden rules (if you remember nothing else)

1. **They message first. Always.**
2. **Get your number saved in their contacts before anything else.**
3. **Links and QR only inside an active conversation.**
4. **Prefer join-request + approve over direct add.**
5. **Never repeat an action at someone who didn't respond** (links, adds, reminders).
6. **Slow is alive. Fast is banned.** Every gap and delay the bot adds is protection, not a bug.
7. **A banned number rests 2+ weeks and gets appealed — or gets replaced.**

---

*Sources: [WhatsApp — About group suspensions](https://faq.whatsapp.com/679236580386110),
[WhatsApp — Suspicious links](https://faq.whatsapp.com/393169153028916),
[WhatsApp — Suspicious messages & scams](https://faq.whatsapp.com/2286952358121083),
[Baileys mass-ban reports #1869](https://github.com/WhiskeySockets/Baileys/issues/1869) /
[#1850](https://github.com/WhiskeySockets/Baileys/issues/1850),
[whatsapp-web.js addParticipants ban discussion](https://github.com/pedroslopez/whatsapp-web.js/issues/2158),
[Achiya — WhatsApp spam detection 2026](https://achiya-automation.com/en/blog/whatsapp-spam-detection-2026/),
[Safe group growth practices](https://www.careerbuildingschool.com/blog/how-to-safely-grow-your-whatsapp-group-without-risking-account-suspension-best-practices-tips),
plus this repo's git-history ban investigation (2026-07-12).*
