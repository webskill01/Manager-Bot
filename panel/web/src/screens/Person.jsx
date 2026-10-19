import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { OUTCOMES, inr, shortDate, when, ago, botLabel, addDays, isoDay } from '../format.js';
import { Badge, Button, Drawer, Field, Loading, Modal, Select, copy, cx, inputCls, useToast } from '../ui.jsx';

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

// Log one call. Promise / call back need a date; "Paid" goes through Mark renewed instead,
// because that is what moves the billing date in the sheet.
export function CallForm({ phone, bot, onDone, onPaid }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [dueAt, setDueAt] = useState(`${isoDay(addDays(1))}T11:00`);
  const [busy, setBusy] = useState(false);
  const needsDate = outcome === 'promise' || outcome === 'callback';
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
          <button key={k} type="button" onClick={() => (k === 'paid' ? onPaid?.() : setOutcome(k))}
            className={cx('h-11 rounded-lg border text-sm font-medium transition',
              outcome === k ? 'border-brand bg-brand-sky text-brand-deep' : 'border-line bg-white text-ink hover:bg-bg',
              k === 'paid' && 'text-emerald-700')}>
            {k === 'paid' ? 'Paid · mark renewed' : o.label}
          </button>
        ))}
      </div>
      {needsDate && (
        <Field label={outcome === 'promise' ? 'They will pay by' : 'Call them back at'}>
          <input type="datetime-local" className={inputCls} value={dueAt} min={`${isoDay()}T00:00`} onChange={e => setDueAt(e.target.value)} required />
        </Field>
      )}
      <textarea className={cx(inputCls, 'h-20 py-2 resize-none')} placeholder="Note (optional): what did they say?" maxLength={1000}
        value={note} onChange={e => setNote(e.target.value)} />
      <Button type="submit" className="w-full" disabled={!outcome || busy}>{busy ? 'Saving…' : 'Save call'}</Button>
    </form>
  );
}

export function RenewModal({ open, onClose, phone, name, bot, billingDate, onDone }) {
  const toast = useToast();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api(`/person/${phone}/renew`, { method: 'POST', body: { bot, seenBillingDate: billingDate } });
      toast(r.message?.split('\n')[0] || 'Renewed');
      onDone?.();
      onClose();
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Mark renewed?">
      <p className="text-sm text-ink-60">
        <b className="text-ink">{name}</b> on <b className="text-ink">{botLabel(bot || '')}</b>. Their billing date {shortDate(billingDate)} moves one
        month forward in the sheet, exactly like the bot's <code>renewed</code> command.
      </p>
      {me?.role !== 'admin' && <p className="text-xs text-ink-40 mt-2">An admin will verify this renewal.</p>}
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={go} disabled={busy} icon="check">{busy ? 'Saving…' : 'Yes, renewed'}</Button>
      </div>
    </Modal>
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
  const [renew, setRenew] = useState(null);
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

          {p.paidOnApp && <div className="rounded-lg bg-emerald-50 text-emerald-800 text-sm px-3 py-2">Paid on the EaseCab app, plan active till {when(p.app.expiresAt)}.</div>}
          {p.followup && (
            <div className="rounded-lg bg-brand-sky text-brand-deep text-sm px-3 py-2">
              Open {p.followup.kind === 'promise' ? 'promise to pay' : 'call back'}: {when(p.followup.due_at)} ({p.users[p.followup.user_id]})
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
                  {m.status === 'ACTIVE' && (
                    <Button size="sm" variant="secondary" icon="check" onClick={() => setRenew(m)}>Mark renewed</Button>
                  )}
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
              <CallForm phone={p.phone} bot={active[0].bot} onDone={changed} onPaid={() => setRenew(active[0])} />
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-3">History</h3>
            <Timeline items={p.timeline} users={p.users} />
          </section>
          {p.app && <p className="text-xs text-ink-40">App: {p.app.status}, last paid {ago(p.app.lastPaidAt)}</p>}
        </div>
      )}
      <RenewModal open={!!renew} onClose={() => setRenew(null)} phone={phone} name={p?.name} bot={renew?.bot} billingDate={renew?.billingDate} onDone={changed} />
    </Drawer>
  );
}
