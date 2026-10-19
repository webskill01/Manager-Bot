import express from 'express';
import { buildQueue, focusOrder } from './lib/queue.js';
import { attribute, team, ageing, funnel, recoveredByDay, byBot } from './lib/stats.js';
import { OUTCOMES } from './lib/db.js';
import { hashPw, checkPw, newToken, tokenHash, validPassword, createRateLimit } from './lib/auth.js';
import { normalizePhone, parseDate, formatDate } from '../core/globalConfig.js';
import crypto from 'node:crypto';

const COOKIE = 'ecp_s';
const SESSION_MS = 30 * 86400e3;
const INVITE_MS = 7 * 86400e3;
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const NAME_RE = /^[\p{L}\p{N} ._-]{2,30}$/u;
const HISTORY_MS = 30 * 86400e3;

const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayAfter = (ddmmyyyy) => { const d = parseDate(ddmmyyyy); d.setDate(d.getDate() + 1); return d; };

function cookieValue(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function createApp({ db, sync, botCfg, renewer, env, staticDir = null }) {
  const app = express();
  const r = express.Router();
  const loginLimit = createRateLimit();
  let lastManualRefresh = 0;

  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Mutations must be JSON: with SameSite=Lax that rules out cross-site form posts (CSRF).
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  // --- auth helpers ------------------------------------------------------------------
  const setSession = (res, userId) => {
    const token = newToken();
    db.addSession(tokenHash(token), userId, new Date(Date.now() + SESSION_MS));
    res.cookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_MS, path: '/' });
  };
  const userOf = (req) => { const t = cookieValue(req); return t ? db.sessionUser(tokenHash(t)) : null; };
  const auth = (req, res, next) => {
    req.user = userOf(req);
    return req.user ? next() : res.status(401).json({ error: 'login' });
  };
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
  const pub = (u) => ({ id: u.id, name: u.name, role: u.role, mustSetPassword: !u.pw_hash });
  const phoneParam = (req, res) => {
    const p = normalizePhone(req.params.phone);
    if (p.length !== 10) { res.status(400).json({ error: 'Bad phone' }); return null; }
    return p;
  };

  // --- shared queue inputs -----------------------------------------------------------
  function filterFrom(q, user) {
    const view = q.view === 'range' ? 'range' : 'today';
    const f = { view, userId: user.id };
    if (view === 'range') {
      if (!DATE_RE.test(q.from || '') || !DATE_RE.test(q.to || '')) return null;
      f.from = q.from; f.to = q.to;
    }
    if (q.bot && botCfg[q.bot]) f.bot = q.bot;
    if (['followup', 'overdue', 'due', 'upcoming'].includes(q.status)) f.status = q.status;
    if (q.assignee === 'me' || q.assignee === 'none') f.assignee = q.assignee;
    else if (/^\d+$/.test(q.assignee || '')) f.assignee = Number(q.assignee);
    return f;
  }
  function queue(filter, user, people = sync.people(), now = new Date()) {
    const rows = buildQueue({
      people, botCfg, filter, now,
      interactions: db.interactionsSince(new Date(now - HISTORY_MS)),
      followups: db.openFollowups(),
      assignments: db.assignments(),
      claims: db.claims(now),
    });
    // Callers see the shared queue and their own work, never a colleague's assignments.
    return user.role === 'admin' ? rows : rows.filter(r => r.assignedTo === null || r.assignedTo === user.id);
  }
  const names = () => Object.fromEntries(db.users().map(u => [u.id, u.name]));
  const payments = (from, to = new Date()) =>
    db.auditByAction('payment_seen', from, to).map(a => ({ ...JSON.parse(a.detail), at: a.at, phone: a.target }));

  // --- public --------------------------------------------------------------------------
  r.get('/health', (req, res) => res.json({ ok: true, lastSync: sync.status().lastSync }));

  r.post('/login', (req, res) => {
    const ip = req.ip;
    if (!loginLimit.allowed(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const { name = '', password = '' } = req.body || {};
    let user = db.userByName(String(name).trim());
    // First run: the configured admin logs in with PANEL_PIN until they set a password.
    if (!user && String(name).trim().toLowerCase() === env.adminName.toLowerCase()) {
      db.createUser({ name: env.adminName, role: 'admin' });
      user = db.userByName(env.adminName);
    }
    const ok = user && user.active && (user.pw_hash
      ? checkPw(String(password), user.pw_hash)
      : user.name.toLowerCase() === env.adminName.toLowerCase()
        && crypto.timingSafeEqual(crypto.createHash('sha256').update(String(password)).digest(), crypto.createHash('sha256').update(env.pin).digest()));
    if (!ok) { loginLimit.fail(ip); return res.status(401).json({ error: 'Wrong name or password' }); }
    loginLimit.clear(ip);
    setSession(res, user.id);
    db.audit(user.id, 'login', '', { ip });
    res.json(pub(user));
  });

  r.post('/join', (req, res) => {
    const { token = '', name = '', password = '' } = req.body || {};
    const clean = String(name).trim();
    if (!NAME_RE.test(clean)) return res.status(400).json({ error: 'Name: 2-30 letters, numbers, spaces' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.userByName(clean)) return res.status(409).json({ error: 'That name is taken' });
    const inv = db.takeInvite(tokenHash(token));
    if (!inv) return res.status(400).json({ error: 'This invite link is used or expired. Ask an admin for a new one.' });
    const id = db.createUser({ name: clean, role: inv.role, pwHash: hashPw(password) });
    db.audit(id, 'joined', clean, { role: inv.role, invitedBy: inv.created_by });
    setSession(res, id);
    res.json(pub(db.userById(id)));
  });

  // --- signed in -----------------------------------------------------------------------
  r.use(auth);

  r.post('/logout', (req, res) => {
    db.dropSession(tokenHash(cookieValue(req)));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  r.get('/me', (req, res) => res.json({ ...pub(req.user), bots: Object.keys(botCfg), sync: sync.status() }));
  r.post('/password', (req, res) => {
    const { old = '', password = '' } = req.body || {};
    if (req.user.pw_hash && !checkPw(String(old), req.user.pw_hash)) return res.status(400).json({ error: 'Current password is wrong' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.updateUser(req.user.id, { pwHash: hashPw(password) });
    db.audit(req.user.id, 'password_changed', req.user.name);
    res.json({ ok: true });
  });

  r.get('/queue', (req, res) => {
    const filter = filterFrom(req.query, req.user);
    if (!filter) return res.status(400).json({ error: 'Dates must be DD-MM-YYYY' });
    const rows = queue(filter, req.user);
    const open = rows.filter(x => !x.blocked);
    res.json({
      rows,
      users: names(),
      kpis: {
        total: rows.length,
        toCall: open.length,
        followups: rows.filter(x => x.reason === 'followup').length,
        promised: rows.filter(x => x.blocked === 'promised').length,
        amount: open.reduce((s, x) => s + x.amount, 0),
      },
      sync: sync.status(),
    });
  });

  // Focus: the next person for me. Each candidate is claimed, then re-checked against the
  // sheet and the app; anyone who paid in the meantime is skipped and reported.
  r.get('/focus/next', async (req, res) => {
    const filter = filterFrom(req.query, req.user);
    if (!filter) return res.status(400).json({ error: 'Dates must be DD-MM-YYYY' });
    const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean));
    const skipped = [];
    for (let tries = 0; tries < 5; tries++) {
      const order = focusOrder(queue(filter, req.user), req.user.id).filter(x => !exclude.has(x.phone));
      const next = order[0];
      if (!next) return res.json({ row: null, remaining: 0, skipped });
      if (!db.claim(next.phone, req.user.id)) { exclude.add(next.phone); continue; }
      const person = await sync.recheck(next.phone);
      const fresh = person && queue(filter, req.user, new Map([[person.phone, person]])).find(x => x.phone === next.phone);
      if (!fresh || fresh.blocked) {
        skipped.push({ name: next.name, reason: person?.paidOnApp ? 'paid on app' : 'paid or changed' });
        exclude.add(next.phone);
        continue;
      }
      return res.json({ row: fresh, remaining: order.length, timeline: db.timeline(next.phone).slice(0, 5), users: names(), skipped });
    }
    res.json({ row: null, remaining: 0, skipped, busy: true });
  });

  r.get('/person/:phone', (req, res) => {
    const phone = phoneParam(req, res);
    if (!phone) return;
    const p = sync.people().get(phone);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const assignment = db.assignments().find(a => a.phone === phone) || null;
    if (req.user.role !== 'admin' && assignment && assignment.user_id !== req.user.id) return res.status(403).json({ error: 'Assigned to someone else' });
    res.json({
      phone,
      name: p.name,
      memberships: p.members.map(({ bot, member }) => ({
        bot, status: member.status, billingDate: member.billingDate, joinDate: member.joinDate,
        renewals: member.renewals, paidLast: member.paidLast, lastRenewed: member.lastRenewed,
        amount: botCfg[bot]?.renewal?.fullAmount ?? null, delayUntil: member.delayUntil, carNo: member.carNo,
      })),
      app: p.app ? { status: p.app.status, expiresAt: p.app.expiresAt, lastPaidAt: p.app.lastPaidAt, paidCount: p.app.paidCount } : null,
      paidOnApp: p.paidOnApp,
      lead: p.lead,
      followup: db.openFollowups().find(f => f.phone === phone) || null,
      assignedTo: assignment?.user_id ?? null,
      timeline: db.timeline(phone),
      users: names(),
    });
  });

  r.post('/person/:phone/interaction', (req, res) => {
    const phone = phoneParam(req, res);
    if (!phone) return;
    const { outcome, note = '', dueAt = null, bot = '' } = req.body || {};
    if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'Pick an outcome' });
    if (typeof note !== 'string' || note.length > 1000) return res.status(400).json({ error: 'Note too long' });
    const needsDate = outcome === 'promise' || outcome === 'callback';
    if (needsDate && Number.isNaN(Date.parse(dueAt))) return res.status(400).json({ error: 'Pick a date and time' });
    if (!sync.people().has(phone)) return res.status(404).json({ error: 'Not found' });
    db.logInteraction({ phone, bot: botCfg[bot] ? bot : '', userId: req.user.id, outcome, note: note.trim(), dueAt: needsDate ? new Date(dueAt) : null });
    res.json({ ok: true });
  });

  r.post('/person/:phone/renew', async (req, res) => {
    const phone = phoneParam(req, res);
    if (!phone) return;
    const { bot = '', seenBillingDate = '' } = req.body || {};
    const out = await renewer.markRenewed({ phone, bot, seenBillingDate, user: req.user });
    res.status(out.status).json(out.status === 200 ? { ok: true, message: out.message } : { error: out.error });
  });

  r.get('/followups', (req, res) => {
    const people = sync.people();
    const mine = req.query.mine === '1' || req.user.role !== 'admin';
    const rows = db.openFollowups()
      .filter(f => !mine || f.user_id === req.user.id)
      .map(f => ({ ...f, name: people.get(f.phone)?.name || '', bot: people.get(f.phone)?.active[0]?.bot || '', note: db.timeline(f.phone)[0]?.note || '' }));
    res.json({ rows, users: names() });
  });

  r.get('/me/stats', (req, res) => {
    const from = startOfDay();
    const interactions = db.interactionsBetween(from, new Date());
    const pays = attribute(payments(new Date(from - 7 * 86400e3)), db.interactionsSince(new Date(from - 7 * 86400e3)))
      .filter(p => p.at >= from.toISOString());
    const [mine] = team({ users: [req.user], interactions, followups: db.followupsBetween(from, new Date()), payments: pays });
    res.json(mine);
  });

  // --- admin ---------------------------------------------------------------------------
  r.post('/assign', admin, (req, res) => {
    const { phones, userId = null } = req.body || {};
    if (!Array.isArray(phones) || !phones.length || phones.length > 3000) return res.status(400).json({ error: 'Pick some members' });
    const clean = [...new Set(phones.map(normalizePhone).filter(p => p.length === 10))];
    if (userId !== null && !db.userById(userId)?.active) return res.status(400).json({ error: 'Unknown user' });
    db.assign(clean, userId, req.user.id);
    db.audit(req.user.id, userId ? 'assigned' : 'unassigned', userId ? names()[userId] : '', { count: clean.length });
    res.json({ ok: true, count: clean.length });
  });

  r.get('/dashboard', admin, (req, res) => {
    const today = formatDate(new Date());
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : today;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : today;
    const lo = parseDate(from), hi = dayAfter(to);
    if (lo >= hi) return res.status(400).json({ error: 'From must be before To' });
    const unpaid = queue({ view: 'range', from, to }, req.user);
    const interactions = db.interactionsBetween(lo, hi);
    const allPays = attribute(payments(new Date(lo - 40 * 86400e3)), db.interactionsSince(new Date(lo - 40 * 86400e3)));
    const inWindow = allPays.filter(p => p.at >= lo.toISOString() && p.at < hi.toISOString());
    const users = db.users();
    res.json({
      from, to,
      funnel: funnel({ rows: unpaid, interactions, payments: allPays, from, to }),
      ageing: ageing(queue({ view: 'today' }, req.user)),
      byBot: byBot(unpaid, inWindow),
      recovered: recoveredByDay(inWindow),
      totals: {
        recovered: inWindow.reduce((s, p) => s + p.amount, 0),
        byTeam: inWindow.filter(p => p.userId).reduce((s, p) => s + p.amount, 0),
        unpaidAmount: unpaid.reduce((s, x) => s + x.amount, 0),
        calls: interactions.length,
      },
      team: team({ users, interactions, followups: db.followupsBetween(lo, hi), payments: inWindow }),
    });
  });

  r.get('/renewals/unverified', admin, (req, res) => {
    const verified = new Set(db.auditByAction('renew_verified', new Date(0), new Date(Date.now() + 1000)).map(a => a.target));
    const rows = db.auditByAction('renewed', new Date(Date.now() - 60 * 86400e3), new Date(Date.now() + 1000))
      .filter(a => !JSON.parse(a.detail).verified && !verified.has(String(a.id)))
      .map(a => ({ id: a.id, phone: a.target, at: a.at, user: names()[a.user_id], ...JSON.parse(a.detail), name: sync.people().get(a.target)?.name || '' }));
    res.json({ rows });
  });
  r.post('/renewals/:id/verify', admin, (req, res) => {
    db.audit(req.user.id, 'renew_verified', String(Number(req.params.id)));
    res.json({ ok: true });
  });

  r.get('/users', admin, (req, res) => res.json({ rows: db.users() }));
  r.post('/invites', admin, (req, res) => {
    const role = req.body?.role === 'admin' ? 'admin' : 'caller';
    const token = newToken();
    db.addInvite(tokenHash(token), role, req.user.id, new Date(Date.now() + INVITE_MS));
    db.audit(req.user.id, 'invite_created', role);
    res.json({ token, role, expiresInDays: INVITE_MS / 86400e3 });
  });
  r.patch('/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.userById(id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role or access' });
    const { role, active } = req.body || {};
    db.updateUser(id, {
      role: ['admin', 'caller'].includes(role) ? role : undefined,
      active: typeof active === 'boolean' ? active : undefined,
    });
    db.audit(req.user.id, 'user_updated', u.name, { role, active });
    res.json({ ok: true });
  });

  r.get('/audit', admin, (req, res) => {
    const before = /^\d+$/.test(req.query.before || '') ? Number(req.query.before) : 1e15;
    res.json({ rows: db.auditPage(before, 100) });
  });

  r.post('/refresh', async (req, res) => {
    if (Date.now() - lastManualRefresh < 30e3) return res.json({ ok: true, sync: sync.status(), throttled: true });
    lastManualRefresh = Date.now();
    await sync.refresh();
    res.json({ ok: true, sync: sync.status() });
  });

  app.use('/api', r);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  if (staticDir) {
    // Hashed assets cache for a year; index.html never, so a deploy shows up on the next load.
    const noCache = (res) => res.set('Cache-Control', 'no-cache');
    app.use('/assets', express.static(`${staticDir}/assets`, { maxAge: '1y', immutable: true }));
    app.use(express.static(staticDir, { setHeaders: (res, file) => file.endsWith('.html') && noCache(res) }));
    app.get('*', (req, res) => { noCache(res); res.sendFile('index.html', { root: staticDir }); });
  }
  app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    console.error('panel error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
