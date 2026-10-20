import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { when, botLabel, isoDay } from '../format.js';
import { Badge, Card, Empty, Loading, PageHead, cx, useStored, useToast } from '../ui.jsx';
import PersonDrawer from './Person.jsx';

export default function Followups() {
  const me = useMe();
  const toast = useToast();
  const [mine, setMine] = useStored('fu.mine', me.role !== 'admin');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api(`/followups${mine ? '?mine=1' : ''}`).then(setData, e => toast(e.message, 'bad')), [mine]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const now = new Date().toISOString();
  const today = isoDay();
  const rows = [...(data?.rows || [])].sort((a, b) => a.due_at.localeCompare(b.due_at));
  const groups = [
    ['Overdue', rows.filter(f => f.due_at < now)],
    ['Today', rows.filter(f => f.due_at >= now && isoDay(new Date(f.due_at)) === today)],
    ['Upcoming', rows.filter(f => isoDay(new Date(f.due_at)) > today)],
  ];

  return (
    <>
      <PageHead title="Follow-ups" sub="Promises, call-backs and unanswered calls, oldest first">
        {me.role === 'admin' && (
          <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
            {[[true, 'Mine'], [false, 'Everyone']].map(([v, l]) => (
              <button key={l} type="button" onClick={() => setMine(v)}
                className={cx('h-8 px-3 rounded-md text-xs font-medium', mine === v ? 'bg-brand-sky text-brand-deep' : 'text-ink-60')}>{l}</button>
            ))}
          </div>
        )}
      </PageHead>
      {!data ? <Loading /> : !rows.length && !data.noAnswer?.length ? <Card><Empty title="No open follow-ups" hint="Promises and call-backs you log show up here." /></Card> : (
        <div className="space-y-6">
          {groups.filter(([, xs]) => xs.length).map(([title, xs]) => (
            <section key={title}>
              <h2 className={cx('text-xs font-semibold uppercase tracking-wide mb-2', title === 'Overdue' ? 'text-bad' : 'text-ink-40')}>{title} · {xs.length}</h2>
              <Card className="divide-y divide-line">
                {xs.map(f => (
                  <button key={f.id} type="button" onClick={() => setOpen(f.phone)} className="w-full text-left flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-bg">
                    <div className="w-32 shrink-0 text-sm tabular-nums">{when(f.due_at)}</div>
                    <div className="flex-1 min-w-[160px]">
                      <div className="font-medium text-sm">{f.name || f.phone}</div>
                      {f.note && <div className="text-xs text-ink-60 truncate max-w-md">{f.note}</div>}
                    </div>
                    <Badge tone={f.kind === 'promise' ? 'blue' : 'amber'}>{f.kind === 'promise' ? 'Promise' : 'Call back'}</Badge>
                    <span className="text-xs text-ink-40 w-20">{botLabel(f.bot)}</span>
                    {!mine && <span className="text-xs text-ink-60 w-20 truncate">{data.users[f.user_id]}</span>}
                  </button>
                ))}
              </Card>
            </section>
          ))}
          {data.noAnswer?.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-ink-40">No answer · last 3 days · {data.noAnswer.length}</h2>
              <Card className="divide-y divide-line">
                {data.noAnswer.map(f => (
                  <button key={f.id} type="button" onClick={() => setOpen(f.phone)} className="w-full text-left flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-bg">
                    <div className="w-32 shrink-0 text-sm tabular-nums text-ink-60">{when(f.at)}</div>
                    <div className="flex-1 min-w-[160px]">
                      <div className="font-medium text-sm">{f.name || f.phone}</div>
                      {f.note && <div className="text-xs text-ink-60 truncate max-w-md">{f.note}</div>}
                    </div>
                    <Badge tone="gray">No answer</Badge>
                    <span className="text-xs text-ink-40 w-20">{botLabel(f.bot)}</span>
                    {!mine && <span className="text-xs text-ink-60 w-20 truncate">{data.users[f.user_id]}</span>}
                  </button>
                ))}
              </Card>
            </section>
          )}
        </div>
      )}
      <PersonDrawer phone={open} onClose={() => setOpen(null)} onChanged={load} />
    </>
  );
}
