import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useMe, go, SyncStatus } from '../App.jsx';
import { APP_STATES, BLOCKED, OUTCOMES, REASONS, inr, num, shortDate, daysLabel, ago, botLabel } from '../format.js';
import { Badge, Button, Card, DateFilter, Empty, Kpi, Loading, PageHead, Select, cx, dateQuery, dateText, useStored, useToast } from '../ui.jsx';
import PersonDrawer from './Person.jsx';

export default function Queue() {
  const me = useMe();
  const toast = useToast();
  const [dates, setDates] = useStored('q.dates', { preset: 'today' });
  const [f, setF] = useStored('q.filter.v2', { bot: '', status: 'due', app: '', assignee: '' });
  const [sort, setSort] = useStored('q.sort', 'priority');
  // Picking a day preset also picks its matching status; the status can still be changed after.
  const pickDates = (d) => {
    if (d.preset !== dates.preset) setF({ ...f, status: PRESET_STATUS[d.preset] ?? '' });
    setDates(d);
  };
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const isAdmin = me.role === 'admin';
  const query = useMemo(() => ({ ...dateQuery(dates), ...f }), [dates, f]);

  const load = useCallback(() => api(`/queue?${qs(query)}`).then(setData, e => toast(e.message, 'bad')), [query]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setSel(new Set()); load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 60e3); return () => clearInterval(t); }, [load]);

  const refresh = async () => {
    setBusy(true);
    try { await api('/refresh', { method: 'POST' }); await load(); } finally { setBusy(false); }
  };
  const assign = async (userId) => {
    try {
      const r = await api('/assign', { method: 'POST', body: { phones: [...sel], userId: userId ? Number(userId) : null } });
      toast(userId ? `${r.count} assigned to ${data.users[userId]}` : `${r.count} back in the shared queue`);
      setSel(new Set());
      load();
    } catch (e) { toast(e.message, 'bad'); }
  };
  const toggle = (phone) => setSel(s => { const n = new Set(s); n.has(phone) ? n.delete(phone) : n.add(phone); return n; });
  const rows = useMemo(() => sortRows(data?.rows || [], sort), [data, sort]);
  const allSel = rows.length > 0 && rows.every(r => sel.has(r.phone));

  return (
    <>
      <PageHead title="Call queue" sub={<>{dateText(dates)} · <SyncStatus sync={data?.sync} className="inline" /></>}>
        <Button variant="secondary" icon="refresh" onClick={refresh} disabled={busy}>Refresh</Button>
        <Button icon="play" onClick={() => go(`#/focus?${qs(query)}`)} disabled={!data?.kpis.toCall}>Start calling</Button>
      </PageHead>

      {/* phones: date strip full width, then the three filters in one row */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 mb-4">
        <div className="col-span-2 sm:col-auto"><DateFilter value={dates} onChange={pickDates} /></div>
        <Select value={f.bot} onChange={e => setF({ ...f, bot: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Bot">
          <option value="">All bots</option>
          {me.bots.map(b => <option key={b} value={b}>{botLabel(b)}</option>)}
        </Select>
        <Select value={f.status} onChange={e => setF({ ...f, status: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(REASONS).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
        </Select>
        <Select value={f.app} onChange={e => setF({ ...f, app: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="App status">
          <option value="">Any app status</option>
          {['signed_up', 'lapsed', 'none'].map(k => <option key={k} value={k}>{APP_STATES[k].label}</option>)}
        </Select>
        <Select value={f.assignee} onChange={e => setF({ ...f, assignee: e.target.value })} className="h-9 w-full sm:w-auto min-w-0" aria-label="Assignee">
          <option value="">{isAdmin ? 'Everyone' : 'Shared + mine'}</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {isAdmin && data && Object.entries(data.users).filter(([id]) => Number(id) !== me.id).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </Select>
        <Select value={sort} onChange={e => setSort(e.target.value)} className="h-9 w-full sm:w-auto min-w-0" aria-label="Sort">
          {Object.entries(SORTS).map(([k, [label]]) => <option key={k} value={k}>Sort: {label}</option>)}
        </Select>
      </div>

      {!data ? <Loading /> : <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Kpi label="To call now" value={num(data.kpis.toCall)} sub={`of ${num(data.kpis.total)} in this view`} tone="brand" />
          <Kpi label="Follow-ups due" value={num(data.kpis.followups)} />
          <Kpi label="Promised, waiting" value={num(data.kpis.promised)} />
          <Kpi label="App members" value={num(data.kpis.onApp)} sub={`${num(data.kpis.groupsOnly)} still only in groups`} tone="ok" />
        </div>

        {isAdmin && sel.size > 0 && (
          <div className="sticky top-14 lg:top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink text-white px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium mr-auto">{sel.size} selected</span>
            <Select className="h-8 text-ink" value="" onChange={e => e.target.value && assign(e.target.value)} aria-label="Assign to">
              <option value="">Assign to…</option>
              {Object.entries(data.users).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </Select>
            <Button size="sm" variant="secondary" onClick={() => assign(null)}>Unassign</Button>
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setSel(new Set())}>Clear</Button>
          </div>
        )}

        <Card className="overflow-hidden">
          {!rows.length ? <Empty title="Nobody to call here" hint="Try another date or clear the filters." /> : <>
            {/* desktop: dense table */}
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-bg text-xs text-ink-60 text-left">
                <tr>
                  {isAdmin && <th className="w-10 pl-4"><input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map(r => r.phone)))} /></th>}
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Bot</th>
                  <th className="px-4 py-2.5 font-medium">Billing</th>
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Last call</th>
                  {isAdmin && <th className="px-4 py-2.5 font-medium">Assigned</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(r => (
                  <tr key={r.phone} onClick={() => setOpen(r.phone)} className={cx('cursor-pointer hover:bg-bg', r.blocked && 'text-ink-60')}>
                    {isAdmin && <td className="pl-4" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.phone)} onChange={() => toggle(r.phone)} /></td>}
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-ink">{r.name || '—'}</div>
                      <div className="text-xs text-ink-40 tabular-nums">{r.phone}</div>
                    </td>
                    <td className="px-4 py-2.5">{botLabel(r.bot)}{r.alsoOn.length > 0 && <span className="text-xs text-ink-40"> +{r.alsoOn.length}</span>}</td>
                    <td className="px-4 py-2.5">
                      <div>{shortDate(r.billingDate)}</div>
                      <div className={cx('text-xs', r.days < 0 ? 'text-bad' : 'text-ink-40')}>{daysLabel(r.days)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{inr(r.amount)}</td>
                    <td className="px-4 py-2.5"><Status r={r} users={data.users} me={me} /></td>
                    <td className="px-4 py-2.5"><Last r={r} users={data.users} /></td>
                    {isAdmin && <td className="px-4 py-2.5 text-ink-60">{data.users[r.assignedTo] || '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* phones: cards */}
            <ul className="md:hidden divide-y divide-line">
              {rows.map(r => (
                <li key={r.phone} className={cx('flex gap-3 p-4', r.blocked && 'opacity-70')}>
                  {isAdmin && <input type="checkbox" className="mt-1" aria-label={`Select ${r.name}`} checked={sel.has(r.phone)} onChange={() => toggle(r.phone)} />}
                  <button type="button" onClick={() => setOpen(r.phone)} className="flex-1 text-left min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{r.name || r.phone}</div>
                        <div className="text-xs text-ink-40">{botLabel(r.bot)} · {shortDate(r.billingDate)} · <span className={r.days < 0 ? 'text-bad' : ''}>{daysLabel(r.days)}</span></div>
                      </div>
                      <div className="text-sm font-semibold tabular-nums">{inr(r.amount)}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-2"><Status r={r} users={data.users} me={me} /><Last r={r} users={data.users} inline /></div>
                  </button>
                </li>
              ))}
            </ul>
          </>}
        </Card>
      </>}

      <PersonDrawer phone={open} onClose={() => setOpen(null)} onChanged={load} />
    </>
  );
}

const PRESET_STATUS = { today: 'due', yesterday: 'overdue', tomorrow: 'upcoming' };   // day / range: any status

// List order only; Start calling keeps the server's priority order (follow-ups first).
const APP_RANK = { signed_up: 0, lapsed: 1, none: 2 };
const SORTS = {
  priority: ['Priority', null],
  overdue: ['Most overdue', (a, b) => a.days - b.days],
  app: ['App status', (a, b) => APP_RANK[a.appState] - APP_RANK[b.appState] || a.days - b.days],
  lastCall: ['Longest since a call', (a, b) => (a.last?.at || '').localeCompare(b.last?.at || '')],
  name: ['Name', (a, b) => (a.name || '~').localeCompare(b.name || '~')],
};
function sortRows(rows, sort) {
  const cmp = SORTS[sort]?.[1];
  return cmp ? [...rows].sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || cmp(a, b)) : rows;
}

function Status({ r, users, me }) {
  if (r.claimedBy && r.claimedBy !== me.id) return <Badge tone="amber">{users[r.claimedBy]} is calling</Badge>;
  if (r.blocked) return <Badge>{BLOCKED[r.blocked]}</Badge>;
  return <>
    <Badge tone={REASONS[r.reason].tone}>{REASONS[r.reason].label}</Badge>
    <Badge tone={APP_STATES[r.appState]?.tone}>{APP_STATES[r.appState]?.label}</Badge>
  </>;
}

function Last({ r, users, inline }) {
  if (!r.last) return <span className="text-xs text-ink-40">{inline ? '' : 'Not called'}</span>;
  return (
    <span className={cx('text-xs', inline ? 'text-ink-40' : '')}>
      <span className="text-ink">{OUTCOMES[r.last.outcome]?.label}</span>
      <span className="text-ink-40"> · {users[r.last.user_id]} · {ago(r.last.at)}</span>
    </span>
  );
}
