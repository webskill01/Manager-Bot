import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { APP_STATES, OUTCOMES, addDays, botLabel, isoDay, num, when } from '../format.js';
import { Badge, Button, Card, Empty, Loading, MultiSelect, PageHead, Select, cx, inputCls, useStored, useToast } from '../ui.jsx';
import PersonDrawer from './Person.jsx';

// Everyone called, one row each: latest call (chip + note + time), times called, open follow-up.
// Paying on the app moves them out of the list into the "Moved to app" count by itself.
// Other rows stay until an admin clears them.
const CALLED = { any: 'Called any time', today: 'Called today', yesterday: 'Called yesterday', week: 'Last 7 days', day: 'Called on…' };
const TIMES = { any: 'Any no. of calls', 1: 'Called once', 2: 'Called twice', 3: '3+ calls', 5: '5+ calls' };
const SORTS = {
  recent: ['Last called, newest', (a, b) => b.last.at.localeCompare(a.last.at)],
  oldest: ['Last called, oldest', (a, b) => a.last.at.localeCompare(b.last.at)],
  most: ['Most calls', (a, b) => b.count - a.count || b.last.at.localeCompare(a.last.at)],
  due: ['Next follow-up', (a, b) => (a.followup?.due_at || '~').localeCompare(b.followup?.due_at || '~')],
  name: ['Name', (a, b) => (a.name || a.phone).localeCompare(b.name || b.phone)],
};

export default function Followups() {
  const me = useMe();
  const toast = useToast();
  const isAdmin = me.role === 'admin';
  const [f, setF] = useStored('fu.filter', { called: 'any', day: isoDay(), outcome: [], bot: [], times: 'any', caller: '', sort: 'recent' });
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState(new Set());
  const load = useCallback(() => api('/followups').then(setData, e => toast(e.message, 'bad')), []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const [from, to] = { today: [isoDay(), isoDay()], yesterday: [isoDay(addDays(-1)), isoDay(addDays(-1))], week: [isoDay(addDays(-6)), isoDay()], day: [f.day, f.day] }[f.called] || [];
    return (data?.rows || []).filter(r => !r.converted   // paid on the app: done, counted on the dashboard
      && (!from || r.at.some(t => { const d = isoDay(new Date(t)); return d >= from && d <= to; }))
      && (!f.outcome.length || f.outcome.includes(r.last.outcome))
      && (!f.bot.length || f.bot.includes(r.bot))
      && (f.times === 'any' || (Number(f.times) < 3 ? r.count === Number(f.times) : r.count >= Number(f.times)))
      && (!f.caller || String(r.last.user_id) === f.caller),
    ).sort(SORTS[f.sort][1]);
  }, [data, f]);
  const allSel = rows.length > 0 && rows.every(r => sel.has(r.phone));
  const toggle = (phone) => setSel(s => { const n = new Set(s); n.has(phone) ? n.delete(phone) : n.add(phone); return n; });

  const act = async (path, body, msg) => {
    try { const r = await api(path, { method: 'POST', body }); toast(msg(r.count)); setSel(new Set()); load(); } catch (e) { toast(e.message, 'bad'); }
  };
  const clear = (phones) => act('/followups/clear', { phones }, n => `${n} cleared from follow-ups`);
  const assign = (userId) => act('/assign', { phones: [...sel], userId: userId ? Number(userId) : null }, n => `${n} assigned to ${data.users[userId]}`);
  const now = new Date().toISOString();

  return (
    <>
      <PageHead title="Follow-ups" sub={data ? `${num(rows.length)} people · ${num(rows.reduce((s, r) => s + r.count, 0))} calls · paid ones leave by themselves` : 'Everyone you called'} />


      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 mb-4">
        <Select value={f.called} onChange={e => setF({ ...f, called: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Called when">
          {Object.entries(CALLED).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {f.called === 'day' && <input type="date" aria-label="Day called" className={cx(inputCls, 'h-9 sm:w-auto')} value={f.day} max={isoDay()} onChange={e => setF({ ...f, day: e.target.value })} />}
        <MultiSelect label="Last action" value={f.outcome} onChange={outcome => setF({ ...f, outcome })} all="Any action" className="min-w-0"
          options={Object.entries(OUTCOMES).filter(([k]) => k !== 'paid').map(([k, o]) => [k, o.label])} />
        {me.bots.length > 1 && <MultiSelect label="Bot" value={f.bot} onChange={bot => setF({ ...f, bot })} all="All bots" className="min-w-0"
          options={me.bots.map(b => [b, botLabel(b)])} />}
        <Select value={f.times} onChange={e => setF({ ...f, times: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Times called">
          {Object.entries(TIMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {isAdmin && data && (
          <Select value={f.caller} onChange={e => setF({ ...f, caller: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Last called by">
            <option value="">Any caller</option>
            {Object.entries(data.users).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
        )}
        <Select value={f.sort} onChange={e => setF({ ...f, sort: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Sort">
          {Object.entries(SORTS).map(([k, [l]]) => <option key={k} value={k}>Sort: {l}</option>)}
        </Select>
      </div>

      {isAdmin && sel.size > 0 && (
        <div className="sticky top-14 lg:top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink text-white px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium mr-auto">{sel.size} selected</span>
          <Select className="h-8 text-ink" value="" onChange={e => e.target.value && assign(e.target.value)} aria-label="Assign to">
            <option value="">Assign to…</option>
            {Object.entries(data.users).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
          <Button size="sm" variant="secondary" onClick={() => clear([...sel])}>Clear from list</Button>
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setSel(new Set())}>Cancel</Button>
        </div>
      )}

      {!data ? <Loading /> : !rows.length ? <Card><Empty title="Nobody here" hint="Everyone you call shows up here. Try another filter." /></Card> : (
        <Card className="divide-y divide-line">
          {isAdmin && (
            <label className="flex items-center gap-3 px-4 py-2.5 bg-bg text-xs text-ink-60">
              <input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map(r => r.phone)))} />
              Select all {num(rows.length)}
            </label>
          )}
          {rows.map(r => {
            const o = OUTCOMES[r.last.outcome];
            const late = r.followup && r.followup.due_at < now;
            return (
              <div key={r.phone} className="flex gap-3 px-4 py-3">
                {isAdmin && <input type="checkbox" className="mt-1" aria-label={`Select ${r.name}`} checked={sel.has(r.phone)} onChange={() => toggle(r.phone)} />}
                <button type="button" onClick={() => setOpen(r.phone)} className="flex-1 min-w-0 text-left">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-sm">{r.name || r.phone}</span>
                    <Badge tone={o?.tone}>{o?.label || r.last.outcome}</Badge>
                    {r.appState !== 'none' && <Badge tone={APP_STATES[r.appState].tone}>{APP_STATES[r.appState].label}</Badge>}
                    <Badge tone={r.count >= 3 ? 'amber' : 'gray'}>{r.count}× called</Badge>
                  </div>
                  {r.last.note && <div className="text-sm text-ink-60 mt-1">{r.last.note}</div>}
                  <div className="text-xs text-ink-40 mt-1">
                    {when(r.last.at)} · {data.users[r.last.user_id] || '—'}{r.bot && ` · ${botLabel(r.bot)}`}
                    {r.followup && <span className={late ? 'text-bad' : ''}> · {r.followup.kind === 'promise' ? 'promised by' : 'call back'} {when(r.followup.due_at)}</span>}
                  </div>
                </button>
                {isAdmin && <Button size="sm" variant="ghost" className="self-start" onClick={() => clear([r.phone])} aria-label={`Clear ${r.name}`}>Clear</Button>}
              </div>
            );
          })}
        </Card>
      )}
      <PersonDrawer phone={open} onClose={() => setOpen(null)} onChanged={load} />
    </>
  );
}
