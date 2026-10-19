import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../api.js';
import { go } from '../App.jsx';
import { APP_STATES, REASONS, inr, num, shortDate, daysLabel, botLabel, when } from '../format.js';
import { Badge, Button, Card, Empty, Loading, useToast } from '../ui.jsx';
import { CallForm, ContactButtons, Timeline } from './Person.jsx';

// One person at a time. The server claims them for 10 minutes and re-checks the sheet and
// the app first, so someone who just paid on the app is skipped instead of being called.
export default function Focus({ query }) {
  const toast = useToast();
  const [cur, setCur] = useState(undefined);   // undefined = loading, null = queue done
  const [done, setDone] = useState(0);
  const [stats, setStats] = useState(null);
  const skippedHere = useRef([]);

  const next = useCallback(async () => {
    setCur(undefined);
    try {
      const r = await api(`/focus/next?${qs({ ...query, exclude: skippedHere.current.join(',') })}`);
      for (const s of r.skipped) toast(`${s.name || 'A member'} skipped: ${s.reason}`, 'info');
      if (r.busy) toast('Everyone left is being called by a teammate right now', 'info');
      setCur(r.row ? r : null);
    } catch (e) { toast(e.message, 'bad'); setCur(null); }
    api('/me/stats').then(setStats, () => {});
  }, [query]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { next(); }, [next]);

  const advance = () => { setDone(d => d + 1); next(); };
  const skip = () => { skippedHere.current.push(cur.row.phone); next(); };
  const row = cur?.row;
  const total = done + (cur?.remaining || 0);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={() => go('#/queue')}>← Back to queue</Button>
        {stats && <div className="text-xs text-ink-60 text-right">Today: <b className="text-ink">{num(stats.calls)}</b> calls · <b className="text-ink">{num(stats.promises)}</b> promises · <b className="text-ok">{num(stats.paidCount)}</b> moved</div>}
      </div>

      <div className="h-1.5 rounded-full bg-line overflow-hidden mb-5" role="progressbar" aria-valuenow={done} aria-valuemax={total}>
        <div className="h-full bg-brand transition-all" style={{ width: total ? `${(done / total) * 100}%` : '0%' }} />
      </div>

      {cur === undefined ? <Loading /> : !row ? (
        <Card><Empty title={done ? `Done. ${done} people handled.` : 'Nobody left to call'} hint="Promised and retry-later people come back when they are due." />
          <div className="flex justify-center pb-8"><Button onClick={() => go('#/queue')}>Back to queue</Button></div>
        </Card>
      ) : (
        <Card className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <Badge tone={REASONS[row.reason].tone}>{REASONS[row.reason].label}</Badge>
                <Badge tone={APP_STATES[row.appState]?.tone}>{APP_STATES[row.appState]?.label}</Badge>
                <span className="text-xs text-ink-40">{done + 1} of {total}</span>
              </div>
              <h1 className="text-2xl font-semibold truncate">{row.name || row.phone}</h1>
              <p className="text-sm text-ink-60 mt-1">
                {botLabel(row.bot)}{row.alsoOn.length > 0 && ` + ${row.alsoOn.map(botLabel).join(', ')}`} · billing {shortDate(row.billingDate)} · <span className={row.days < 0 ? 'text-bad font-medium' : ''}>{daysLabel(row.days)}</span>
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs text-ink-40">App plan</div>
              <div className="text-2xl font-semibold tabular-nums">{inr(row.amount)}</div>
            </div>
          </div>

          {row.followup && (
            <div className="mt-4 rounded-lg bg-brand-sky text-brand-deep text-sm px-3 py-2">
              {row.followup.kind === 'promise' ? 'Promised to move by' : 'Asked for a call back at'} {when(row.followup.due_at)}
            </div>
          )}

          <div className="mt-5"><ContactButtons phone={row.phone} size="lg" /></div>

          <div className="mt-6 pt-5 border-t border-line">
            <CallForm key={row.phone} phone={row.phone} bot={row.bot} onDone={advance} />
          </div>

          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" icon="skip" onClick={skip}>Skip for now</Button>
          </div>

          {cur.timeline?.length > 0 && (
            <div className="mt-5 pt-5 border-t border-line">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-40 mb-3">Earlier calls</h3>
              <Timeline items={cur.timeline} users={cur.users} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
