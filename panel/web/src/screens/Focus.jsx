import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../api.js';
import { go } from '../App.jsx';
import { num } from '../format.js';
import { Button, Card, Empty, Loading, useToast } from '../ui.jsx';
import { PersonBody } from './Person.jsx';

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
          <div className="flex items-center justify-between mb-3 text-xs text-ink-40">
            <span>{done + 1} of {total}</span>
            <Button variant="ghost" size="sm" icon="skip" onClick={skip}>Skip for now</Button>
          </div>
          <PersonBody p={cur.person} onDone={advance}
            onChanged={() => api(`/person/${row.phone}`).then(person => setCur(c => ({ ...c, person })), () => {})} />
        </Card>
      )}
    </div>
  );
}
