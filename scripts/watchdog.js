#!/usr/bin/env node
// Watchdog — polls every bot's /health on localhost and, when a bot goes down or
// logged-out, broadcasts an alert to the admin numbers through the first healthy
// bot's localhost-only /alert endpoint. Runs as its own pm2 app (see ecosystem
// config). If NO bot is healthy, alerts queue and flush once one recovers.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 60000);
const FAIL_THRESHOLD = Number(process.env.WATCHDOG_FAIL_THRESHOLD || 3); // consecutive bad checks (~3 min) — skips pm2 restarts and reconnect blips

// Bots may live on different VPSes: health is checked over each bot's PUBLIC_HOST,
// but alert relay always targets 127.0.0.1 (the /alert endpoint is loopback-only) —
// remote bots simply fail fast locally and the next candidate is tried.
export function botsFromEcosystem(ecoPath) {
  const eco = require(ecoPath);
  return eco.apps
    .filter(a => a.env?.STATS_PORT)
    .map(a => ({
      name: a.name,
      port: Number(a.env.STATS_PORT),
      host: a.env.PUBLIC_HOST || '127.0.0.1',
    }));
}

async function fetchJson(url, opts = {}, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const PREFERRED_SENDER = process.env.WATCHDOG_PREFERRED_SENDER || 'bot-nitin';

export function createWatchdog(bots, { failThreshold = FAIL_THRESHOLD, log = console, preferredSender = PREFERRED_SENDER } = {}) {
  // per-bot: consecutive fail count + which alerts have already fired (no spam)
  const state = new Map(bots.map(b => [b.name, { fails: 0, alertedDown: false, alertedLoggedOut: false }]));
  const pending = []; // alerts not yet delivered (queued while no bot is healthy)

  const ts = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

  async function tick() {
    const results = new Map();
    for (const bot of bots) {
      try {
        results.set(bot.name, await fetchJson(`http://${bot.host || '127.0.0.1'}:${bot.port}/health`));
      } catch {
        results.set(bot.name, null);
      }
    }

    for (const bot of bots) {
      const s = state.get(bot.name);
      const h = results.get(bot.name);

      // logged-out (401/403 halt) is definitive — alert immediately, once
      if (h?.loggedOut && !s.alertedLoggedOut) {
        s.alertedLoggedOut = true;
        pending.push(`🚨 *${bot.name}* is LOGGED OUT (401/403 — number likely flagged).\nReconnects halted. Do NOT rescan until the number is confirmed healthy.\n[${ts()}]`);
      }
      if (h && !h.loggedOut) s.alertedLoggedOut = false;

      const down = !h || (!h.connected && !h.loggedOut);
      if (down) {
        s.fails++;
        if (s.fails === failThreshold && !s.alertedDown) {
          s.alertedDown = true;
          pending.push(`🚨 *${bot.name}* is ${h ? 'disconnected from WhatsApp' : 'not responding'} (${failThreshold} checks in a row).\n[${ts()}]`);
        }
      } else {
        if (s.alertedDown) pending.push(`✅ *${bot.name}* is healthy again.\n[${ts()}]`);
        s.fails = 0;
        s.alertedDown = false;
      }
    }

    // Deliver queued alerts. Candidates: preferred bot (most reliable / owner-run)
    // first, then every other connected bot. Relay is always via 127.0.0.1 —
    // /alert only accepts loopback — so candidates running on ANOTHER VPS fail
    // instantly (nothing bound on that local port) and the next one is tried.
    // Undeliverable alerts stay queued and retry next tick.
    // A dual-transport bot can relay over Telegram with no WhatsApp connection at all, and
    // that is precisely the case that matters: when bot-nitin's number is flagged, the alert
    // saying so must not sit queued forever because the only bot on the box reads
    // connected:false. /health reports `telegram: true` when its listener is live.
    const canRelay = (name) => {
      const h = results.get(name);
      return !!(h?.connected || h?.telegram);
    };
    while (pending.length) {
      const candidates = [
        ...bots.filter(b => b.name === preferredSender && canRelay(b.name)),
        ...bots.filter(b => b.name !== preferredSender && canRelay(b.name)),
      ];
      let delivered = false;
      for (const sender of candidates) {
        try {
          await fetchJson(`http://127.0.0.1:${sender.port}/alert`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: pending[0] }),
          });
          log.log?.(`📣 Alert sent via ${sender.name}: ${pending[0].split('\n')[0]}`);
          pending.shift();
          delivered = true;
          break;
        } catch {
          // not on this machine or relay failed — try the next candidate
        }
      }
      if (!delivered) {
        log.warn?.(`⚠️  ${pending.length} alert(s) pending — no bot on this machine can relay right now`);
        break;
      }
    }
  }

  return { tick, state, pending };
}

// ── pm2 entry ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ecoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ecosystem.config.cjs');
  const bots = botsFromEcosystem(ecoPath);
  console.log(`🐶 Watchdog started — monitoring ${bots.map(b => `${b.name}@${b.host}:${b.port}`).join(', ')} every ${INTERVAL_MS / 1000}s (alert after ${FAIL_THRESHOLD} misses, preferred sender ${PREFERRED_SENDER})`);
  const wd = createWatchdog(bots);
  wd.tick().catch(() => {});
  setInterval(() => wd.tick().catch(err => console.error(`watchdog tick error: ${err.message}`)), INTERVAL_MS);
}
