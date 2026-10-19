import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { APP_STATES, addDays, dmy, inr, num, shortDate, botLabel, toDmy, toIso } from '../format.js';
import { Card, Empty, Kpi, Loading, PageHead, cx, inputCls, useStored, useToast } from '../ui.jsx';

const PRESETS = [['today', 'Today'], ['7d', '7 days'], ['month', 'This month'], ['range', 'Custom']];
function range(v) {
  if (v.preset === 'today') return { from: dmy(), to: dmy() };
  if (v.preset === '7d') return { from: dmy(addDays(-6)), to: dmy() };
  if (v.preset === 'month') { const d = new Date(); d.setDate(1); return { from: dmy(d), to: dmy() }; }
  return { from: v.from, to: v.to };
}

export default function Dashboard() {
  const toast = useToast();
  const [v, setV] = useStored('dash.range', { preset: '7d', from: dmy(addDays(-6)), to: dmy() });
  const [d, setD] = useState(null);
  const r = useMemo(() => range(v), [v]);
  const load = useCallback(() => {
    api(`/dashboard?${qs(r)}`).then(setD, e => toast(e.message, 'bad'));
  }, [r]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setD(null); load(); }, [load]);

  return (
    <>
      <PageHead title="Dashboard" sub={`${shortDate(r.from)} – ${shortDate(r.to)}`}>
        <div className="flex w-full sm:w-auto rounded-lg border border-line bg-white p-0.5">
          {PRESETS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setV({ ...v, preset: k })}
              className={cx('h-8 flex-1 sm:flex-none px-1.5 sm:px-3 whitespace-nowrap rounded-md text-xs font-medium', v.preset === k ? 'bg-brand-sky text-brand-deep' : 'text-ink-60 hover:text-ink')}>{l}</button>
          ))}
        </div>
        {v.preset === 'range' && <>
          <input type="date" aria-label="From" className={cx(inputCls.replace('w-full ', ''), 'h-9')} value={toIso(v.from)} onChange={e => e.target.value && setV({ ...v, from: toDmy(e.target.value) })} />
          <input type="date" aria-label="To" className={cx(inputCls.replace('w-full ', ''), 'h-9')} value={toIso(v.to)} min={toIso(v.from)} onChange={e => e.target.value && setV({ ...v, to: toDmy(e.target.value) })} />
        </>}
      </PageHead>

      {!d ? <Loading /> : (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold">Group members on the app <span className="font-normal text-ink-40">· now</span></h2>
              <span className="text-sm text-ink-60"><b className="text-ink">{pct(d.totals.onApp, migrated(d.totals))}%</b> paying on the app</span>
            </div>
            <Migration t={d.totals} />
          </Card>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Moved to app" value={num(d.totals.moved)} sub={`${inr(d.totals.movedAmount)} paid on the app`} tone="ok" />
            <Kpi label="After a team call" value={num(d.totals.byTeam)} sub="moved within 7 days of a call" />
            <Kpi label="Renewed in groups" value={num(d.totals.renewedInGroups)} sub="the old way, still to move" tone="warn" />
            <Kpi label="Calls logged" value={num(d.totals.calls)} />
          </div>

          <div className="grid lg:grid-cols-3 gap-5">
            <Card className="p-5 lg:col-span-2">
              <h2 className="text-sm font-semibold mb-4">Moved to app per day</h2>
              <DayBars days={fillDays(d.recovered, r.from, r.to)} />
            </Card>
            <Card className="p-5">
              <h2 className="text-sm font-semibold mb-4">Funnel <span className="font-normal text-ink-40">· billing in range</span></h2>
              <Funnel f={d.funnel} />
            </Card>
          </div>

          <div className="grid lg:grid-cols-3 gap-5">
            <Card className="lg:col-span-2 overflow-x-auto">
              <h2 className="text-sm font-semibold px-5 pt-5 pb-3">Team</h2>
              {!d.team.length ? <Empty title="No team yet" /> : (
                <table className="w-full text-sm">
                  <thead className="bg-bg text-xs text-ink-60 text-left">
                    <tr>{['Caller', 'Calls', 'Connected', 'Promises', 'Kept', 'Moved', 'App ₹'].map((h, i) => <th key={h} className={cx('px-5 py-2.5 font-medium', i && 'text-right')}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-line tabular-nums">
                    {d.team.map(t => (
                      <tr key={t.userId}>
                        <td className="px-5 py-2.5 font-medium">{t.name}</td>
                        <td className="px-5 py-2.5 text-right">{num(t.calls)}</td>
                        <td className="px-5 py-2.5 text-right">{num(t.connected)}</td>
                        <td className="px-5 py-2.5 text-right">{num(t.promises)}</td>
                        <td className="px-5 py-2.5 text-right">{num(t.promisesKept)}</td>
                        <td className="px-5 py-2.5 text-right">{num(t.paidCount)}</td>
                        <td className="px-5 py-2.5 text-right font-medium text-ok">{inr(t.recovered)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card className="p-5">
              <h2 className="text-sm font-semibold mb-4">Overdue now <span className="font-normal text-ink-40">· by days late</span></h2>
              <Ageing a={d.ageing} />
            </Card>
          </div>

          <div>
            <Card className="overflow-x-auto">
              <h2 className="text-sm font-semibold px-5 pt-5 pb-3">By bot</h2>
              {!d.byBot.length ? <Empty title="Nothing in this range" /> : (
                <table className="w-full text-sm">
                  <thead className="bg-bg text-xs text-ink-60 text-left">
                    <tr>{['Bot', 'To move', 'At ₹149', 'Moved / renewed', '₹'].map((h, i) => <th key={h} className={cx('px-5 py-2.5 font-medium', i && 'text-right')}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-line tabular-nums">
                    {d.byBot.map(b => (
                      <tr key={b.bot}>
                        <td className="px-5 py-2.5 font-medium">{botLabel(b.bot)}</td>
                        <td className="px-5 py-2.5 text-right">{num(b.unpaid)}</td>
                        <td className="px-5 py-2.5 text-right text-bad">{inr(b.unpaidAmount)}</td>
                        <td className="px-5 py-2.5 text-right">{num(b.paid)}</td>
                        <td className="px-5 py-2.5 text-right text-ok">{inr(b.paidAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

const migrated = (t) => t.onApp + t.lapsedOnApp + t.signedUpOnApp + t.notOnApp;
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

// Every group member (any bot sheet) by app state; one stacked bar plus the counts.
function Migration({ t }) {
  const parts = [['member', t.onApp, 'bg-ok'], ['lapsed', t.lapsedOnApp, 'bg-warn'], ['signed_up', t.signedUpOnApp, 'bg-brand'], ['none', t.notOnApp, 'bg-line']];
  const total = migrated(t);
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-bg">
        {parts.map(([k, n, c]) => <div key={k} className={c} style={{ width: `${pct(n, total)}%` }} title={`${APP_STATES[k].label}: ${n}`} />)}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
        {parts.map(([k, n, c]) => (
          <div key={k}>
            <dt className="flex items-center gap-1.5 text-xs text-ink-60"><span className={cx('w-2 h-2 rounded-full', c)} />{APP_STATES[k].label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{num(n)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Every day of the range, zero when nothing came in, so one good day doesn't fill the chart.
function fillDays(days, from, to) {
  const got = new Map(days.map(x => [x.date, x]));
  const out = [];
  for (let d = new Date(toIso(from) + 'T00:00'); d <= new Date(toIso(to) + 'T00:00') && out.length < 120; d = addDays(1, d)) {
    out.push(got.get(dmy(d)) || { date: dmy(d), amount: 0, count: 0 });
  }
  return out;
}

function DayBars({ days }) {
  if (!days.some(x => x.count)) return <Empty title="No payments in this range" />;
  const max = Math.max(...days.map(x => x.amount), 1);
  const w = 100 / days.length;
  return (
    <div>
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" className="w-full h-44" role="img" aria-label="Recovered per day">
        {days.map((x, i) => {
          const h = (x.amount / max) * 46;
          return <rect key={x.date} x={i * w + w * 0.15} y={50 - h} width={w * 0.7} height={h} rx="0.8" className="fill-brand"><title>{`${shortDate(x.date)}: ${inr(x.amount)} (${x.count})`}</title></rect>;
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-ink-40 mt-2">
        <span>{shortDate(days[0].date)}</span><span>max {inr(max)}</span><span>{shortDate(days.at(-1).date)}</span>
      </div>
    </div>
  );
}

function Funnel({ f }) {
  const steps = [['Due', f.due], ['Contacted', f.contacted], ['Promised', f.promised], ['Moved to app', f.paid]];
  const max = Math.max(f.due, 1);
  return (
    <div className="space-y-3">
      {steps.map(([l, n], i) => (
        <div key={l}>
          <div className="flex justify-between text-xs mb-1"><span className="text-ink-60">{l}</span><span className="font-medium tabular-nums">{num(n)}{i > 0 && f.due > 0 && <span className="text-ink-40 font-normal"> · {Math.round((n / f.due) * 100)}%</span>}</span></div>
          <div className="h-2.5 rounded-full bg-bg"><div className={cx('h-full rounded-full', i === 3 ? 'bg-ok' : 'bg-brand')} style={{ width: `${(n / max) * 100}%`, opacity: 1 - i * 0.15 }} /></div>
        </div>
      ))}
    </div>
  );
}

function Ageing({ a }) {
  const rows = [['1–2 days', a['1-2'], 'bg-warn'], ['3–5 days', a['3-5'], 'bg-orange-500'], ['6+ days', a['6+'], 'bg-bad']];
  const max = Math.max(...rows.map(r => r[1]), 1);
  return (
    <div className="space-y-3">
      {rows.map(([l, n, c]) => (
        <div key={l}>
          <div className="flex justify-between text-xs mb-1"><span className="text-ink-60">{l}</span><span className="font-medium tabular-nums">{num(n)}</span></div>
          <div className="h-2.5 rounded-full bg-bg"><div className={cx('h-full rounded-full', c)} style={{ width: `${(n / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
