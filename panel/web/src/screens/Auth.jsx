import { useState } from 'react';
import { api } from '../api.js';
import { Button, Field, inputCls } from '../ui.jsx';

function Shell({ title, sub, children }) {
  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 bg-gradient-to-b from-brand-sky to-bg">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <img src="/logo.png" alt="EaseCab" className="w-14 h-14 rounded-2xl shadow-card" />
          <h1 className="text-xl font-semibold mt-4">{title}</h1>
          <p className="text-sm text-ink-60 mt-1 text-center">{sub}</p>
        </div>
        <div className="bg-white border border-line rounded-2xl shadow-card p-6">{children}</div>
        <p className="text-center text-xs text-ink-40 mt-6">EaseCab Partners · internal use only</p>
      </div>
    </div>
  );
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

export function Login({ onDone }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api('/login', { method: 'POST', body: { name, password } }); onDone(); });
  return (
    <Shell title="Panel" sub="EaseCab team · sign in to see today's calls">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus required /></Field>
        <Field label="PIN"><input type="password" inputMode="numeric" className={inputCls} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        {error && <p className="text-sm text-bad" role="alert">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </Shell>
  );
}

export function Join({ token, onDone }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api('/join', { method: 'POST', body: { token, name, password } }); onDone(); });
  return (
    <Shell title="Join the team" sub="Pick the name your team will see and a 4-digit PIN">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} autoComplete="username" maxLength={30} autoFocus required /></Field>
        <Field label="PIN" hint="4 digits"><input type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} className={inputCls} value={password} onChange={e => setPassword(e.target.value.replace(/\D/g, ''))} autoComplete="new-password" required /></Field>
        {error && <p className="text-sm text-bad" role="alert">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
      </form>
    </Shell>
  );
}
