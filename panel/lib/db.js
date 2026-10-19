import { DatabaseSync } from 'node:sqlite';

// The panel's own data: who works here and what they did. Member records are NOT stored
// here: the bot sheets stay the source of truth and are re-read by sync.js.
// All times are ISO UTC strings, so string comparison is time comparison.

export const OUTCOMES = ['paid', 'promise', 'callback', 'no_answer', 'not_interested', 'wrong_number'];
export const CLAIM_MS = 10 * 60e3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','caller')), pw_hash TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, created_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS interactions(id INTEGER PRIMARY KEY, phone TEXT NOT NULL, bot TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', due_at TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_int_phone ON interactions(phone, at);
CREATE INDEX IF NOT EXISTS ix_int_user ON interactions(user_id, at);
CREATE TABLE IF NOT EXISTS followups(id INTEGER PRIMARY KEY, phone TEXT NOT NULL, user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('promise','callback')), due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT);
CREATE INDEX IF NOT EXISTS ix_fu_open ON followups(status, due_at);
CREATE TABLE IF NOT EXISTS assignments(phone TEXT PRIMARY KEY, user_id INTEGER NOT NULL, assigned_by INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims(phone TEXT PRIMARY KEY, user_id INTEGER NOT NULL, until TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit(action, at);
`;

const iso = (d = new Date()) => new Date(d).toISOString();

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const api = {
    raw: db,
    tx,

    // --- users / sessions / invites -------------------------------------------------
    createUser({ name, role, pwHash = '' }) {
      return Number(q('INSERT INTO users(name, role, pw_hash, created_at) VALUES (?,?,?,?)')
        .run(name, role, pwHash, iso()).lastInsertRowid);
    },
    userByName: (name) => q('SELECT * FROM users WHERE name = ?').get(name) || null,
    userById: (id) => q('SELECT * FROM users WHERE id = ?').get(id) || null,
    users: () => q('SELECT id, name, role, active, created_at, pw_hash != \'\' AS has_password FROM users ORDER BY id').all(),
    updateUser(id, { role, active, pwHash }) {
      if (role !== undefined) q('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      if (active !== undefined) {
        q('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (pwHash !== undefined) q('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, id);
    },
    addSession: (hash, userId, expires) => q('INSERT INTO sessions VALUES (?,?,?)').run(hash, userId, iso(expires)),
    dropSession: (hash) => q('DELETE FROM sessions WHERE token_hash = ?').run(hash),
    sessionUser(hash) {
      return q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(hash, iso()) || null;
    },
    addInvite: (hash, role, by, expires) => q('INSERT INTO invites(token_hash, role, created_by, expires_at) VALUES (?,?,?,?)')
      .run(hash, role, by, iso(expires)),
    takeInvite(hash) {
      const inv = q('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, iso());
      if (inv) q('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(iso(), hash);
      return inv || null;
    },

    // --- calls & follow-ups ------------------------------------------------------------
    // One call = one interaction. Any new outcome closes the phone's open follow-ups; a
    // promise/callback then opens exactly one new one. So a phone has at most one open.
    logInteraction({ phone, bot = '', userId, outcome, note = '', dueAt = null, at = new Date() }) {
      if (!OUTCOMES.includes(outcome)) throw new Error(`bad outcome ${outcome}`);
      const kind = outcome === 'promise' || outcome === 'callback' ? outcome : null;
      if (kind && !dueAt) throw new Error(`${outcome} needs a date`);
      return tx(() => {
        const id = Number(q('INSERT INTO interactions(phone, bot, user_id, outcome, note, due_at, at) VALUES (?,?,?,?,?,?,?)')
          .run(phone, bot, userId, outcome, note, kind ? iso(dueAt) : null, iso(at)).lastInsertRowid);
        q("UPDATE followups SET status = 'closed', closed_at = ? WHERE phone = ? AND status = 'open'").run(iso(at), phone);
        if (kind) q('INSERT INTO followups(phone, user_id, kind, due_at, created_at) VALUES (?,?,?,?,?)')
          .run(phone, userId, kind, iso(dueAt), iso(at));
        q('DELETE FROM claims WHERE phone = ?').run(phone);
        return id;
      });
    },
    closeFollowups: (phone, at = new Date()) =>
      q("UPDATE followups SET status = 'closed', closed_at = ? WHERE phone = ? AND status = 'open'").run(iso(at), phone),
    openFollowups: () => q("SELECT * FROM followups WHERE status = 'open' ORDER BY due_at").all(),
    followupsBetween: (from, to) => q('SELECT * FROM followups WHERE created_at >= ? AND created_at < ?').all(iso(from), iso(to)),
    interactionsSince: (since) => q('SELECT * FROM interactions WHERE at >= ? ORDER BY at').all(iso(since)),
    interactionsBetween: (from, to) => q('SELECT * FROM interactions WHERE at >= ? AND at < ? ORDER BY at').all(iso(from), iso(to)),
    timeline: (phone) => q(`SELECT i.*, u.name AS user_name FROM interactions i LEFT JOIN users u ON u.id = i.user_id
                            WHERE phone = ? ORDER BY at DESC`).all(phone),

    // --- assignment & claims -----------------------------------------------------------
    assign(phones, userId, by) {
      tx(() => {
        for (const p of phones) {
          if (userId) q('INSERT OR REPLACE INTO assignments VALUES (?,?,?,?)').run(p, userId, by, iso());
          else q('DELETE FROM assignments WHERE phone = ?').run(p);
        }
      });
    },
    assignments: () => q('SELECT * FROM assignments').all(),
    // True when this user now holds the phone. Another user's unexpired claim wins.
    claim(phone, userId, now = new Date()) {
      const cur = q('SELECT * FROM claims WHERE phone = ?').get(phone);
      if (cur && cur.user_id !== userId && cur.until > iso(now)) return false;
      q('INSERT OR REPLACE INTO claims VALUES (?,?,?)').run(phone, userId, iso(new Date(now).getTime() + CLAIM_MS));
      return true;
    },
    claims: (now = new Date()) => q('SELECT * FROM claims WHERE until > ?').all(iso(now)),

    // --- audit -------------------------------------------------------------------------
    audit: (userId, action, target = '', detail = {}) =>
      q('INSERT INTO audit(user_id, action, target, detail, at) VALUES (?,?,?,?,?)')
        .run(userId ?? null, action, target, JSON.stringify(detail), iso()),
    auditPage: (before = 1e15, limit = 100) => q(`SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
                                                  WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`).all(before, limit),
    auditByAction: (action, from, to) => q('SELECT * FROM audit WHERE action = ? AND at >= ? AND at < ?').all(action, iso(from), iso(to)),
  };
  return api;
}
