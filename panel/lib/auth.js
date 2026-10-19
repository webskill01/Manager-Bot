import crypto from 'node:crypto';

// scrypt from the stdlib: no bcrypt dependency for three users. Stored as "salt:hash" hex.
export function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPw(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) {
    crypto.scryptSync(pw, 'x', 64);   // same work either way: no name probing by timing
    return false;
  }
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// 4-digit PIN. ponytail: only 10k values, so login is also rate-limited per name, not just per IP.
export const validPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

// Failed logins per key (client IP). ponytail: in-memory, resets on restart — fine for one process.
export function createRateLimit({ max = 5, windowMs = 15 * 60e3, now = Date.now } = {}) {
  const fails = new Map();
  const recent = (k) => (fails.get(k) || []).filter(t => now() - t < windowMs);
  return {
    allowed: (k) => recent(k).length < max,
    fail: (k) => fails.set(k, [...recent(k), now()]),
    clear: (k) => fails.delete(k),
  };
}
