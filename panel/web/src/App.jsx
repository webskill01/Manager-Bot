import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, whenLoggedOut } from './api.js';
import { ago } from './format.js';
import { Button, Icon, Loading, Modal, Field, inputCls, cx, useToast } from './ui.jsx';
import { Login, Join } from './screens/Auth.jsx';
import Queue from './screens/Queue.jsx';
import Focus from './screens/Focus.jsx';
import Followups from './screens/Followups.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Summary from './screens/Summary.jsx';
import Users from './screens/Users.jsx';
import Audit from './screens/Audit.jsx';

const MeCtx = createContext(null);
export const useMe = () => useContext(MeCtx);

// #/queue, #/focus?view=today, #/join/<token> → { path: 'focus', arg, query }
function useRoute() {
  const read = () => {
    const [p, q = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [path, arg] = p.split('/');
    return { path: path || 'queue', arg, query: Object.fromEntries(new URLSearchParams(q)) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => setRoute(read());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return route;
}
export const go = (hash) => { location.hash = hash; };

const NAV = [
  { path: 'queue', label: 'Queue', icon: 'list' },
  { path: 'followups', label: 'Follow-ups', icon: 'calendar' },
  { path: 'summary', label: 'Summary', icon: 'bars' },
  { path: 'dashboard', label: 'Dashboard', icon: 'chart', admin: true },
  { path: 'users', label: 'Team', icon: 'users', admin: true },
  { path: 'audit', label: 'Activity', icon: 'activity', admin: true },
];

export default function App() {
  const route = useRoute();
  const [me, setMe] = useState(undefined);   // undefined = loading, null = signed out
  const load = useCallback(() => api('/me').then(setMe, () => setMe(null)), []);
  useEffect(() => { whenLoggedOut(() => setMe(null)); load(); }, [load]);

  if (route.path === 'join') return <Join token={route.arg} onDone={() => { go('#/queue'); load(); }} />;
  if (me === undefined) return <Loading />;
  if (!me) return <Login onDone={load} />;

  const nav = NAV.filter(n => !n.admin || me.role === 'admin');
  const path = nav.some(n => n.path === route.path) || route.path === 'focus' ? route.path : 'queue';
  const Screen = { queue: Queue, focus: Focus, followups: Followups, summary: Summary, dashboard: Dashboard, users: Users, audit: Audit }[path];

  return (
    <MeCtx.Provider value={{ ...me, reload: load }}>
      <div className="min-h-screen lg:pl-60">
        <Sidebar nav={nav} path={path} me={me} onLogout={() => setMe(null)} />
        <TopBar me={me} onLogout={() => setMe(null)} />
        <main className="px-4 sm:px-6 lg:px-8 py-5 lg:py-7 pb-24 lg:pb-10 max-w-[1400px] mx-auto">
          <Screen query={route.query} arg={route.arg} />
        </main>
        <BottomTabs nav={nav} path={path} />
      </div>
      <SetPassword open={me.mustSetPassword} forced onDone={load} />
    </MeCtx.Provider>
  );
}

const Logo = ({ className = 'w-8 h-8' }) => <img src="/logo.png" alt="" className={cx('rounded-lg', className)} />;

function Sidebar({ nav, path, me, onLogout }) {
  const [pw, setPw] = useState(false);
  const logout = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); onLogout(); };
  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 w-60 flex-col bg-white border-r border-line">
      <div className="flex items-center gap-3 px-5 h-16 border-b border-line">
        <Logo />
        <div className="leading-tight">
          <div className="font-semibold text-sm">Panel</div>
          <div className="text-xs text-ink-60">EaseCab team</div>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {nav.map(n => (
          <a key={n.path} href={`#/${n.path}`}
            className={cx('flex items-center gap-3 h-10 px-3 rounded-lg text-sm font-medium transition',
              path === n.path ? 'bg-brand-sky text-brand-deep' : 'text-ink-60 hover:bg-bg hover:text-ink')}>
            <Icon name={n.icon} />{n.label}
          </a>
        ))}
      </nav>
      <SyncStatus sync={me.sync} className="px-5 pb-3" />
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="w-8 h-8 rounded-full bg-brand-sky text-brand-deep grid place-items-center text-sm font-semibold">{me.name[0].toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{me.name}</div>
            <div className="text-xs text-ink-60 capitalize">{me.role}</div>
          </div>
          <Button variant="ghost" size="sm" icon="key" onClick={() => setPw(true)} aria-label="Change PIN" title="Change PIN" />
          <Button variant="ghost" size="sm" icon="logout" onClick={logout} aria-label="Sign out" title="Sign out" />
        </div>
      </div>
      <SetPassword open={pw} onDone={() => setPw(false)} />
    </aside>
  );
}

function TopBar({ me, onLogout }) {
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const logout = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); onLogout(); };
  return (
    <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-4 bg-white/95 backdrop-blur border-b border-line">
      <div className="flex items-center gap-2.5"><Logo className="w-7 h-7" /><span className="font-semibold text-sm">Panel</span></div>
      <div className="relative">
        <button type="button" onClick={() => setMenu(m => !m)} aria-label="Account"
          className="w-8 h-8 rounded-full bg-brand-sky text-brand-deep grid place-items-center text-sm font-semibold">{me.name[0].toUpperCase()}</button>
        {menu && (
          <div className="absolute right-0 mt-2 w-52 bg-white border border-line rounded-xl shadow-lg p-1 text-sm">
            <div className="px-3 py-2 border-b border-line mb-1"><div className="font-medium">{me.name}</div><div className="text-xs text-ink-60 capitalize">{me.role}</div></div>
            <button type="button" className="w-full text-left px-3 py-2 rounded-lg hover:bg-bg" onClick={() => { setMenu(false); setPw(true); }}>Change PIN</button>
            <button type="button" className="w-full text-left px-3 py-2 rounded-lg hover:bg-bg text-bad" onClick={logout}>Sign out</button>
          </div>
        )}
      </div>
      <SetPassword open={pw} onDone={() => setPw(false)} />
    </header>
  );
}

function BottomTabs({ nav, path }) {
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-line flex pb-[env(safe-area-inset-bottom)]">
      {nav.map(n => (
        <a key={n.path} href={`#/${n.path}`}
          className={cx('flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', path === n.path ? 'text-brand' : 'text-ink-60')}>
          <Icon name={n.icon} className="w-5 h-5" />{n.label}
        </a>
      ))}
    </nav>
  );
}

export function SyncStatus({ sync, className }) {
  const errs = Object.entries(sync?.errors || {}).filter(([, v]) => v);
  return (
    <div className={cx('text-xs', className)} title={errs.map(([k, v]) => `${k}: ${v}`).join('\n')}>
      <span className={cx('inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle', errs.length ? 'bg-warn' : 'bg-ok')} />
      <span className="text-ink-60">{errs.length ? `${errs.length} source${errs.length > 1 ? 's' : ''} failing · ` : 'Synced '}{ago(sync?.lastSync)}</span>
    </div>
  );
}

function SetPassword({ open, forced, onDone }) {
  const me = useMe();
  const toast = useToast();
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/password', { method: 'POST', body: { old, password: pw } });
      toast('PIN saved');
      setOld(''); setPw('');
      onDone();
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={forced ? () => {} : onDone} title={forced ? 'Set your PIN' : 'Change PIN'}>
      {forced && <p className="text-sm text-ink-60 mb-4">Choose a 4-digit PIN for signing in next time.</p>}
      <form onSubmit={save} className="space-y-3">
        {!forced && me && <Field label="Current PIN"><input type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} className={inputCls} value={old} onChange={e => setOld(e.target.value)} autoComplete="current-password" /></Field>}
        <Field label="New PIN" hint="4 digits"><input type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} className={inputCls} value={pw} onChange={e => setPw(e.target.value.replace(/\D/g, ''))} autoComplete="new-password" required autoFocus /></Field>
        <div className="flex justify-end gap-2 pt-2">
          {!forced && <Button variant="secondary" onClick={onDone}>Cancel</Button>}
          <Button type="submit" disabled={busy || pw.length !== 4}>Save PIN</Button>
        </div>
      </form>
    </Modal>
  );
}
