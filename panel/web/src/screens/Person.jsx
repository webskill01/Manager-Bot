import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { APP_STATES, OUTCOMES, inr, shortDate, when, ago, botLabel, addDays, isoDay } from '../format.js';
import { Badge, Button, Drawer, Field, Loading, Select, copy, cx, inputCls, useToast } from '../ui.jsx';

const waLink = (phone) => `https://wa.me/91${phone}`;

export function ContactButtons({ phone, size = 'md' }) {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="wa" size={size} icon="phone" href={waLink(phone)} target="_blank" rel="noopener noreferrer">Call on WhatsApp</Button>
      <Button variant="secondary" size={size} icon="copy" onClick={() => copy(phone, toast)}>{phone}</Button>
    </div>
  );
}

// Log one call. Promise / call back need a date. "Moved to app" asks the app first and only
// counts once they have paid there; then they leave the queue by themselves.
export function CallForm({ phone, bot, onDone }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [dueAt, setDueAt] = useState(`${isoDay(addDays(1))}T11:00`);
  const [busy, setBusy] = useState(false);
  const needsDate = outcome === 'promise' || outcome === 'callback';
  const moved = async () => {
    setBusy(true);
    try {
      const r = await api(`/person/${phone}/check`, { method: 'POST', body: {} });
      if (!r.onApp) return toast(`Not yet: ${APP_STATES[r.appState].label.toLowerCase()}`, 'bad');
      await api(`/person/${phone}/interaction`, { method: 'POST', body: { outcome: 'paid', note, bot, dueAt: null } });
      toast('Paid on the app: done');
      setNote('');
      onDone?.('paid');
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/person/${phone}/interaction`, { method: 'POST', body: { outcome, note, bot, dueAt: needsDate ? new Date(dueAt).toISOString() : null } });
      toast(`Saved: ${OUTCOMES[outcome].label}`);
      setOutcome(''); setNote('');
      onDone?.(outcome);
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {Object.entries(OUTCOMES).map(([k, o]) => (
          <button key={k} type="button" disabled={busy} onClick={() => (k === 'paid' ? moved() : setOutcome(k))}
            className={cx('h-11 rounded-lg border text-sm font-medium transition',
              outcome === k ? 'border-brand bg-brand-sky text-brand-deep' : 'border-line bg-white text-ink hover:bg-bg',
              k === 'paid' && 'text-emerald-700')}>
            {o.label}
          </button>
        ))}
      </div>
      {needsDate && (
        <Field label={outcome === 'promise' ? 'They will move to the app by' : 'Call them back at'}>
          <input type="datetime-local" className={inputCls} value={dueAt} min={`${isoDay()}T00:00`} onChange={e => setDueAt(e.target.value)} required />
        </Field>
      )}
      <textarea className={cx(inputCls, 'h-20 py-2 resize-none')} placeholder="Note (optional): what did they say?" maxLength={1000}
        value={note} onChange={e => setNote(e.target.value)} />
      <Button type="submit" className="w-full" disabled={!outcome || busy}>{busy ? 'Saving…' : 'Save call'}</Button>
    </form>
  );
}

export function Timeline({ items, users }) {
  if (!items?.length) return <p className="text-sm text-ink-40">No calls yet.</p>;
  return (
    <ol className="relative border-l border-line ml-1.5 space-y-4">
      {items.map(i => (
        <li key={i.id} className="pl-4 relative">
          <span className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full bg-white border-2 border-brand" />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={OUTCOMES[i.outcome]?.tone}>{OUTCOMES[i.outcome]?.label || i.outcome}</Badge>
            <span className="text-xs text-ink-60">{i.user_name || users?.[i.user_id] || '—'} · {when(i.at)}</span>
          </div>
          {i.due_at && <div className="text-xs text-ink-60 mt-1">Until {when(i.due_at)}</div>}
          {i.note && <p className="text-sm mt-1 whitespace-pre-wrap">{i.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function PersonDrawer({ phone, onClose, onChanged }) {
  const me = useMe();
  const toast = useToast();
  const [p, setP] = useState(null);
  const load = useCallback(() => {
    if (!phone) return;
    api(`/person/${phone}`).then(setP, (e) => { toast(e.message, 'bad'); onClose(); });
  }, [phone]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setP(null); load(); }, [load]);
  const changed = () => { load(); onChanged?.(); };
  const assign = async (userId) => {
    try {
      await api('/assign', { method: 'POST', body: { phones: [phone], userId: userId ? Number(userId) : null } });
      changed();
    } catch (e) { toast(e.message, 'bad'); }
  };
  const active = p?.memberships.filter(m => m.status === 'ACTIVE') || [];

  return (
    <Drawer open={!!phone} onClose={onClose} title={p?.name || phone || ''}>
      {!p ? <Loading /> : (
        <div className="p-5 space-y-6">
          <ContactButtons phone={p.phone} />

          <div className={cx('rounded-lg text-sm px-3 py-2', p.onApp ? 'bg-emerald-50 text-emerald-800' : 'bg-bg text-ink-60')}>
            <Badge tone={APP_STATES[p.appState].tone}>{APP_STATES[p.appState].label}</Badge> {APP_STATES[p.appState].hint}
            {p.app?.paidCount > 0 && <span className="block text-xs mt-1">Paid {p.app.paidCount}× · plan {p.onApp ? 'till' : 'ended'} {when(p.app.expiresAt)}</span>}
          </div>
          {p.followup && (
            <div className="rounded-lg bg-brand-sky text-brand-deep text-sm px-3 py-2">
              Open {p.followup.kind === 'promise' ? 'promise to move' : 'call back'}: {when(p.followup.due_at)} ({p.users[p.followup.user_id]})
            </div>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-2">Memberships</h3>
            <div className="divide-y divide-line border border-line rounded-xl">
              {p.memberships.map(m => (
                <div key={m.bot} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-[110px]">
                    <div className="text-sm font-medium">{botLabel(m.bot)}</div>
                    <Badge tone={m.status === 'ACTIVE' ? 'green' : 'gray'}>{m.status}</Badge>
                  </div>
                  <dl className="grid grid-cols-3 gap-x-4 text-xs flex-1 min-w-[220px]">
                    <div><dt className="text-ink-40">Billing</dt><dd className="font-medium">{shortDate(m.billingDate)}</dd></div>
                    <div><dt className="text-ink-40">Amount</dt><dd className="font-medium">{inr(m.amount)}</dd></div>
                    <div><dt className="text-ink-40">Renewals</dt><dd className="font-medium">{m.renewals || 0}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
          </section>

          {me.role === 'admin' && (
            <section className="flex items-center gap-3">
              <span className="text-sm text-ink-60">Assigned to</span>
              <Select value={p.assignedTo ?? ''} onChange={e => assign(e.target.value)} className="h-9">
                <option value="">Shared queue</option>
                {Object.entries(p.users).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
              </Select>
            </section>
          )}

          {active.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-2">Log a call</h3>
              <CallForm phone={p.phone} bot={active[0].bot} onDone={changed} />
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-3">History</h3>
            <Timeline items={p.timeline} users={p.users} />
          </section>
          {p.app && <p className="text-xs text-ink-40">App: {p.app.status}, last paid {ago(p.app.lastPaidAt)}</p>}
        </div>
      )}
    </Drawer>
  );
}
