import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useMe } from '../App.jsx';
import { addDays, botLabel, dmy, inr, num, shortDate } from '../format.js';
import { Card, Empty, Kpi, Loading, MultiSelect, PageHead, cx, useStored, useToast } from '../ui.jsx';
import { RangePicker, range } from './Dashboard.jsx';

// Our progress day by day: calls, what came of them, and app moves credited to a call.
// Admins filter by callers (none = everyone combined) and bots; a caller sees their own.
const COLS = [
  ['calls', 'Calls'], ['people', 'People'], ['connected', 'Connected'], ['promise', 'Promised'], ['callback', 'Call back'],
  ['no_answer', 'No answer'], ['not_interested', 'Not interested'], ['wrong_number', 'Wrong no.'], ['moved', 'Moved to app'],
];
const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');
const dayLabel = (iso) => new Date(`${iso}T00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

function Table({ first, rows, total, label }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="bg-bg text-xs text-ink-60 text-left">
          <tr>
            <th className="px-4 py-2.5 font-medium sticky left-0 bg-bg">{first}</th>
            {COLS.map(([k, l]) => <th key={k} className="px-3 py-2.5 font-medium text-right">{l}</th>)}
            <th className="px-4 py-2.5 font-medium text-right">App ₹</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[...rows, ...(total ? [{ ...total, key: 'total', label: 'Total' }] : [])].map(r => (
            <tr key={r.key} className={cx(r.key === 'total' && 'font-semibold bg-bg', !r.calls && !r.moved && 'text-ink-40')}>
              <td className={cx('px-4 py-2.5 sticky left-0', r.key === 'total' ? 'bg-bg' : 'bg-white')}>{label(r)}</td>
              {COLS.map(([k]) => (
                <td key={k} className={cx('px-3 py-2.5 text-right tabular-nums', k === 'moved' && r.moved && 'text-ok font-semibold')}>
                  {num(r[k])}{k === 'connected' && r.calls > 0 && <span className="text-xs text-ink-40"> {pct(r.connected, r.calls)}</span>}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums">{inr(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function Summary() {
  const me = useMe();
  const toast = useToast();
  const isAdmin = me.role === 'admin';
  const [v, setV] = useStored('sum.range', { preset: '7d', from: dmy(addDays(-6)), to: dmy() });
  const [f, setF] = useStored('sum.filter', { users: [], bot: [] });
  const [d, setD] = useState(null);
  const r = useMemo(() => range(v), [v]);
  const load = useCallback(() => api(`/summary?${qs({ ...r, ...f })}`).then(setD, e => toast(e.message, 'bad')), [r, f]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setD(null); load(); }, [load]);
  const t = d?.total;

  return (
    <>
      <PageHead title="Summary" sub={`${shortDate(r.from)} – ${shortDate(r.to)}${isAdmin ? ` · ${f.users.length ? f.users.map(id => d?.users[id]).filter(Boolean).join(' + ') : 'everyone'}` : ''}`}>
        <RangePicker v={v} setV={setV} />
      </PageHead>

      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 mb-4">
        {isAdmin && d && <MultiSelect label="Callers" value={f.users} onChange={users => setF({ ...f, users })} all="Everyone" className="min-w-0"
          options={Object.entries(d.users).map(([id, n]) => [id, n])} />}
        {me.bots.length > 1 && <MultiSelect label="Bot" value={f.bot} onChange={bot => setF({ ...f, bot })} all="All bots" className="min-w-0"
          options={me.bots.map(b => [b, botLabel(b)])} />}
      </div>

      {!d ? <Loading /> : !t.calls && !t.moved ? <Card><Empty title="No calls in this range" hint="Pick another range or caller." /></Card> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label="Calls" value={num(t.calls)} sub={`${num(t.people)} people`} tone="brand" />
            <Kpi label="Connected" value={pct(t.connected, t.calls)} sub={`${num(t.connected)} picked up`} />
            <Kpi label="Promised" value={num(t.promise)} sub={`${num(t.callback)} call backs`} />
            <Kpi label="Not interested" value={num(t.not_interested)} sub={`${num(t.no_answer)} no answer`} tone={t.not_interested ? 'bad' : undefined} />
            <Kpi label="Moved to app" value={num(t.moved)} sub={`${inr(t.amount)} · ${pct(t.moved, t.people)} of people`} tone="ok" />
          </div>

          <section>
            <h2 className="text-sm font-semibold mb-2">Per day</h2>
            <Table first="Day" rows={d.days.map(x => ({ ...x, key: x.day }))} total={t} label={x => (x.key === 'total' ? 'Total' : dayLabel(x.day))} />
          </section>

          {isAdmin && d.callers.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2">Per caller</h2>
              <Table first="Caller" rows={d.callers.map(c => ({ ...c, key: c.userId })).sort((a, b) => b.calls - a.calls)} label={x => d.users[x.userId] || '—'} />
            </section>
          )}
          <p className="text-xs text-ink-40">Moved to app = paid on the app within 7 days of a call; it counts for the last caller and the day they paid.</p>
        </div>
      )}
    </>
  );
}
