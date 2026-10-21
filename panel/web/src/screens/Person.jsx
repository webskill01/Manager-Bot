import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { APP_STATES, OUTCOMES, REASONS, inr, shortDate, daysLabel, when, ago, botLabel, addDays, isoDay } from '../format.js';
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
  const [other, setOther] = useState(null);   // null = closed; else the number they paid with ('' = they don't know)
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
  // Sheet has one number, they paid on the app with another (they told us on the call).
  const linkOther = async () => {
    setBusy(true);
    try {
      await api(`/person/${phone}/link`, { method: 'POST', body: { appPhone: other, note, bot } });
      toast(other ? `Marked paid (app number ${other})` : 'Marked paid on another number');
      setOther(null); setNote('');
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
      {other === null ? (
        <button type="button" disabled={busy} onClick={() => { setOther(''); setOutcome(''); }}
          className="w-full h-11 rounded-lg border border-line bg-white text-sm font-medium text-emerald-700 hover:bg-bg">
          Paid with another number
        </button>
      ) : (
        <div className="flex gap-2">
          <input type="tel" inputMode="numeric" className={inputCls} placeholder="Number they paid with (optional)" autoFocus
            value={other} onChange={e => setOther(e.target.value.replace(/[^\d+ ]/g, ''))} maxLength={16} />
          <Button type="button" disabled={busy || (other !== '' && other.replace(/\D/g, '').length < 10)} onClick={linkOther}>{busy ? 'Saving…' : 'Mark paid'}</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setOther(null)}>Cancel</Button>
        </div>
      )}
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

// The one person layout. The drawer (tap a row) and Start calling both render exactly this;
// Start calling only adds its progress bar and a Skip button around it.
export function PersonBody({ p, onDone, onChanged }) {
  const me = useMe();
  const toast = useToast();
  const active = p.memberships.filter(m => m.status === 'ACTIVE');
  const main = active[0] || p.memberships[0];
  const st = APP_STATES[p.appState];
  const assign = async (userId) => {
    try {
      await api('/assign', { method: 'POST', body: { phones: [p.phone], userId: userId ? Number(userId) : null } });
      onChanged?.();
    } catch (e) { toast(e.message, 'bad'); }
  };
  const unlink = async () => {
    try {
      await api(`/person/${p.phone}/unlink`, { method: 'POST', body: {} });
      toast('Undone: back in the queue');
      onChanged?.();
    } catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {p.row && <Badge tone={REASONS[p.row.reason].tone}>{REASONS[p.row.reason].label}</Badge>}
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
          <h2 className="text-2xl font-semibold truncate">{p.name || p.phone}</h2>
          {main && (
            <p className="text-sm text-ink-60 mt-1">
              {botLabel(main.bot)}{active.length > 1 && ` + ${active.slice(1).map(m => botLabel(m.bot)).join(', ')}`} · billing {shortDate(main.billingDate)}
              {main.days !== null && <> · <span className={main.days < 0 ? 'text-bad font-medium' : ''}>{daysLabel(main.days)}</span></>}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-ink-40">App plan</div>
          <div className="text-2xl font-semibold tabular-nums">{inr(p.price)}</div>
        </div>
      </div>

      <div className={cx('rounded-lg text-sm px-3 py-2', p.onApp ? 'bg-emerald-50 text-emerald-800' : 'bg-bg text-ink-60')}>
        {st.hint}
        {p.link && <span className="block text-xs mt-1">Paid on the app with {p.link.appPhone || 'another number'} (they told us on a call)</span>}
        {p.app?.paidCount > 0 && <span className="block text-xs mt-1">Paid {p.app.paidCount}× · plan {p.onApp ? 'till' : 'ended'} {when(p.app.expiresAt)} · last paid {ago(p.app.lastPaidAt)}</span>}
      </div>
      {p.followup && (
        <div className="rounded-lg bg-brand-sky text-brand-deep text-sm px-3 py-2">
          Open {p.followup.kind === 'promise' ? 'promise to move' : 'call back'}: {when(p.followup.due_at)} ({p.users[p.followup.user_id]})
        </div>
      )}

      <ContactButtons phone={p.phone} size="lg" />

      {active.length > 0 && (
        <section className="pt-5 border-t border-line">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-2">Log a call</h3>
          <CallForm key={p.phone} phone={p.phone} bot={active[0].bot} onDone={onDone} />
        </section>
      )}

      <section className="pt-5 border-t border-line">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-2">Memberships</h3>
        <div className="divide-y divide-line border border-line rounded-xl">
          {p.memberships.map(m => (
            <div key={m.bot} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-[110px]">
                <div className="text-sm font-medium">{botLabel(m.bot)}</div>
                <Badge tone={m.status === 'ACTIVE' ? 'green' : 'gray'}>{m.status}</Badge>
              </div>
              <dl className="grid grid-cols-3 gap-x-4 text-xs flex-1 min-w-[200px]">
                <div><dt className="text-ink-40">Billing</dt><dd className="font-medium">{shortDate(m.billingDate)}</dd></div>
                <div><dt className="text-ink-40">Joined</dt><dd className="font-medium">{shortDate(m.joinDate) || '—'}</dd></div>
                <div><dt className="text-ink-40">Renewals</dt><dd className="font-medium">{m.renewals || 0}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      {p.link && (me.role === 'admin' || p.link.userId === me.id) && (
        <section className="flex items-center gap-3">
          <span className="text-sm text-ink-60">Marked paid by mistake?</span>
          <Button size="sm" variant="secondary" onClick={unlink}>Undo paid</Button>
        </section>
      )}

      {me.role === 'admin' && (
        <section className="flex items-center gap-3">
          <span className="text-sm text-ink-60">Assigned to</span>
          <Select value={p.assignedTo ?? ''} onChange={e => assign(e.target.value)} className="h-9">
            <option value="">Shared queue</option>
            {Object.entries(p.users).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
        </section>
      )}

      <section className="pt-5 border-t border-line">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-3">History</h3>
        <Timeline items={p.timeline} users={p.users} />
      </section>
    </div>
  );
}

export default function PersonDrawer({ phone, onClose, onChanged }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const load = useCallback(() => {
    if (!phone) return;
    api(`/person/${phone}`).then(setP, (e) => { toast(e.message, 'bad'); onClose(); });
  }, [phone]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setP(null); load(); }, [load]);
  const changed = () => { load(); onChanged?.(); };

  return (
    <Drawer open={!!phone} onClose={onClose} title={p?.name || phone || ''}>
      <div className="p-5">{!p ? <Loading /> : <PersonBody p={p} onDone={changed} onChanged={changed} />}</div>
    </Drawer>
  );
}
