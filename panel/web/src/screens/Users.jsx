import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../App.jsx';
import { when } from '../format.js';
import { Badge, Button, Card, Loading, Modal, PageHead, Select, copy, inputCls, useToast } from '../ui.jsx';

export default function Users() {
  const me = useMe();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [invite, setInvite] = useState(null);
  const [role, setRole] = useState('caller');
  const load = useCallback(() => api('/users').then(r => setRows(r.rows), e => toast(e.message, 'bad')), []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const update = async (id, patch) => {
    try { await api(`/users/${id}`, { method: 'PATCH', body: patch }); load(); } catch (e) { toast(e.message, 'bad'); }
  };
  const makeInvite = async () => {
    try {
      const r = await api('/invites', { method: 'POST', body: { role } });
      setInvite({ ...r, link: `${location.origin}/#/join/${r.token}` });
    } catch (e) { toast(e.message, 'bad'); }
  };

  return (
    <>
      <PageHead title="Team" sub="Who can sign in, and what they can see">
        <Select value={role} onChange={e => setRole(e.target.value)} className="h-10" aria-label="Role for the invite">
          <option value="caller">Caller</option>
          <option value="admin">Admin</option>
        </Select>
        <Button icon="users" onClick={makeInvite}>Invite</Button>
      </PageHead>

      <Card className="mb-4 p-4 text-sm text-ink-60">
        <b className="text-ink">Callers</b> see the shared queue and their own assignments, log calls and mark renewals (an admin verifies those).
        {' '}<b className="text-ink">Admins</b> also see everyone's work, the dashboard and activity, assign members and manage the team.
      </Card>

      {!rows ? <Loading /> : (
        <Card className="divide-y divide-line">
          {rows.map(u => (
            <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-brand-sky text-brand-deep grid place-items-center text-sm font-semibold">{u.name[0].toUpperCase()}</div>
              <div className="flex-1 min-w-[140px]">
                <div className="font-medium text-sm">{u.name} {u.id === me.id && <span className="text-ink-40 font-normal">(you)</span>}</div>
                <div className="text-xs text-ink-40">Joined {when(u.created_at)}{!u.has_password && ' · no password yet'}</div>
              </div>
              {!u.active && <Badge tone="red">Disabled</Badge>}
              {u.id === me.id ? <Badge tone="blue" className="capitalize">{u.role}</Badge> : <>
                <Select value={u.role} onChange={e => update(u.id, { role: e.target.value })} className="h-8 text-xs" aria-label={`Role of ${u.name}`}>
                  <option value="caller">Caller</option>
                  <option value="admin">Admin</option>
                </Select>
                <Button size="sm" variant={u.active ? 'danger' : 'secondary'} onClick={() => update(u.id, { active: !u.active })}>
                  {u.active ? 'Disable' : 'Enable'}
                </Button>
              </>}
            </div>
          ))}
        </Card>
      )}

      <Modal open={!!invite} onClose={() => setInvite(null)} title={`Invite a new ${invite?.role}`}>
        <p className="text-sm text-ink-60 mb-3">Send this link on WhatsApp. It works once and expires in {invite?.expiresInDays} days. It is only shown now.</p>
        <input readOnly className={inputCls} value={invite?.link || ''} onFocus={e => e.target.select()} />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setInvite(null)}>Done</Button>
          <Button icon="copy" onClick={() => copy(invite.link, toast)}>Copy link</Button>
        </div>
      </Modal>
    </>
  );
}
