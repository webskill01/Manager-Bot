import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { inr, when, botLabel, shortDate } from '../format.js';
import { Badge, Button, Card, Empty, Loading, PageHead, useToast } from '../ui.jsx';

const ACTIONS = {
  login: ['Signed in', 'gray'],
  joined: ['Joined', 'blue'],
  invite_created: ['Created invite', 'blue'],
  user_updated: ['Changed user', 'amber'],
  password_changed: ['Changed password', 'gray'],
  assigned: ['Assigned', 'blue'],
  unassigned: ['Unassigned', 'gray'],
  renewed: ['Marked renewed', 'green'],
  renew_verified: ['Verified renewal', 'green'],
  payment_seen: ['Payment detected', 'green'],
};

function describe(a) {
  const d = (() => { try { return JSON.parse(a.detail || '{}'); } catch { return {}; } })();
  switch (a.action) {
    case 'renewed': return `${a.target} on ${botLabel(d.bot || '')}, was due ${shortDate(d.from)}`;
    case 'payment_seen': return `${a.target} paid ${inr(d.amount)} via ${d.source}${d.bot ? ` (${botLabel(d.bot)})` : ''}`;
    case 'assigned': return `${d.count} members to ${a.target}`;
    case 'unassigned': return `${d.count} members back to the shared queue`;
    case 'user_updated': return `${a.target}${d.role ? ` → ${d.role}` : ''}${d.active !== undefined ? (d.active ? ' enabled' : ' disabled') : ''}`;
    case 'login': return d.ip || '';
    default: return a.target;
  }
}

export default function Audit() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(true);
  const page = async (before) => {
    try {
      const r = await api(`/audit${before ? `?before=${before}` : ''}`);
      setRows(xs => [...(before ? xs : []), ...r.rows]);
      setMore(r.rows.length === 100);
    } catch (e) { toast(e.message, 'bad'); }
  };
  useEffect(() => { page(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHead title="Activity" sub="Everything that changed, newest first. Calls are on each member's history." />
      {!rows ? <Loading /> : !rows.length ? <Card><Empty title="Nothing yet" /></Card> : <>
        <Card className="divide-y divide-line">
          {rows.map(a => {
            const [label, tone] = ACTIONS[a.action] || [a.action, 'gray'];
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="w-32 shrink-0 text-xs text-ink-40 tabular-nums">{when(a.at)}</span>
                <span className="w-24 shrink-0 font-medium truncate">{a.user_name || 'System'}</span>
                <Badge tone={tone}>{label}</Badge>
                <span className="text-ink-60 min-w-0 truncate">{describe(a)}</span>
              </div>
            );
          })}
        </Card>
        {more && <div className="flex justify-center mt-4"><Button variant="secondary" onClick={() => page(rows.at(-1).id)}>Load older</Button></div>}
      </>}
    </>
  );
}
