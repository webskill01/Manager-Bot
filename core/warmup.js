import fs from 'fs';
import path from 'path';

// Post-link warm-up: for the first N hours after a FRESH registration the bot
// stays quiet (no engine resumes, no scheduled sends, delayed admin usync) so a
// new link looks like a normal device, not a bot. The marker lives inside
// authDir, so wiping auth for a re-link also resets the warm-up clock.

const markerFile = (authDir) => path.join(authDir, 'linked-at.json');

// Record the moment a fresh registration completed. No-op if already recorded.
export function markLinkedAt(authDir, now = Date.now()) {
  const f = markerFile(authDir);
  if (fs.existsSync(f)) return;
  try { fs.writeFileSync(f, JSON.stringify({ linkedAt: now })); } catch {}
}

export function getLinkedAt(authDir) {
  try { return JSON.parse(fs.readFileSync(markerFile(authDir), 'utf8')).linkedAt || null; }
  catch { return null; }
}

// True while inside the warm-up window. No marker (bot linked before this
// feature existed = established session) → NOT warming up.
export function inWarmup(authDir, hours = 24, now = Date.now()) {
  const t = getLinkedAt(authDir);
  return t !== null && now - t < hours * 3600 * 1000;
}
