import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { addDays, dmy, toDmy, toIso, isoDay, shortDate } from './format.js';

export const cx = (...c) => c.filter(Boolean).join(' ');

// Stroke icons (24px grid, Lucide-style paths).
const PATHS = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-9',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  play: 'M6 4l14 8-14 8z',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  skip: 'M5 4l10 8-10 8zM19 5v14',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
export function Icon({ name, className = 'w-4 h-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const BTN = {
  primary: 'bg-brand text-white hover:bg-brand-deep disabled:bg-brand/50',
  secondary: 'bg-white text-ink border border-line hover:bg-bg disabled:text-ink-40',
  ghost: 'text-ink-60 hover:bg-bg hover:text-ink',
  danger: 'bg-white text-bad border border-line hover:bg-red-50',
  wa: 'bg-wa text-white hover:brightness-95',
};
export function Button({ variant = 'primary', size = 'md', className, icon, children, ...p }) {
  const El = p.href ? 'a' : 'button';
  return (
    <El
      type={p.href ? undefined : p.type || 'button'}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
        size === 'sm' ? 'h-8 px-3 text-xs' : size === 'lg' ? 'h-12 px-5 text-base' : 'h-10 px-4 text-sm', BTN[variant], className)}
      {...p}
    >
      {icon && <Icon name={icon} className={size === 'lg' ? 'w-5 h-5' : 'w-4 h-4'} />}
      {children}
    </El>
  );
}

const TONES = {
  gray: 'bg-slate-100 text-slate-600',
  blue: 'bg-brand-sky text-brand-deep',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-600',
};
export const Badge = ({ tone = 'gray', children, className }) =>
  <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;

export const Card = ({ className, children }) =>
  <div className={cx('bg-white border border-line rounded-xl shadow-card', className)}>{children}</div>;

export const Spinner = ({ className = 'w-5 h-5' }) =>
  <span className={cx('inline-block rounded-full border-2 border-brand/20 border-t-brand animate-spin', className)} role="status" aria-label="Loading" />;

export const Loading = () => <div className="flex justify-center py-16"><Spinner className="w-7 h-7" /></div>;

export const Empty = ({ title, hint }) => (
  <div className="text-center py-14 px-4">
    <div className="text-sm font-semibold text-ink">{title}</div>
    {hint && <div className="text-sm text-ink-60 mt-1">{hint}</div>}
  </div>
);

export const PageHead = ({ title, sub, children }) => (
  <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {sub && <div className="text-sm text-ink-60 mt-0.5">{sub}</div>}
    </div>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>
);

export const Kpi = ({ label, value, sub, tone }) => (
  <Card className="p-4">
    <div className="text-xs font-medium text-ink-60">{label}</div>
    <div className={cx('text-2xl font-semibold mt-1 tabular-nums', tone === 'bad' && 'text-bad', tone === 'ok' && 'text-ok', tone === 'brand' && 'text-brand')}>{value}</div>
    {sub && <div className="text-xs text-ink-40 mt-0.5">{sub}</div>}
  </Card>
);

export const inputCls = 'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-ink-40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand';
export const Field = ({ label, children, hint }) => (
  <label className="block">
    <span className="block text-xs font-medium text-ink-60 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-xs text-ink-40 mt-1">{hint}</span>}
  </label>
);
export const Select = ({ className, children, ...p }) =>
  <select className={cx(inputCls.replace('w-full ', ''), 'pr-8', className)} {...p}>{children}</select>;

// Right-side panel on desktop, full screen on phones.
export function Drawer({ open, onClose, title, children, width = 'max-w-xl' }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <aside className={cx('relative h-full w-full bg-white shadow-xl flex flex-col', width)} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between gap-3 px-5 h-14 border-b border-line shrink-0">
          <h2 className="font-semibold truncate">{title}</h2>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="Close" />
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl p-5" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// --- toasts ------------------------------------------------------------------------------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random();
    setItems(xs => [...xs, { id, text, tone }]);
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), tone === 'bad' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed z-[60] bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 flex flex-col gap-2 w-[min(92vw,420px)]" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={cx('rounded-lg px-4 py-3 text-sm shadow-lg text-white', t.tone === 'bad' ? 'bg-bad' : t.tone === 'info' ? 'bg-ink' : 'bg-emerald-600')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export async function copy(text, toast) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed', 'bad'); }
}

// --- dates -------------------------------------------------------------------------------
// value: { preset: 'today'|'yesterday'|'tomorrow'|'day'|'range', from, to } (from/to DD-MM-YYYY)
// 'today' is the working queue: overdue within each bot's removal window + due + follow-ups.
export function dateQuery(v) {
  if (v.preset === 'today') return { view: 'today' };
  if (v.preset === 'yesterday') return { view: 'range', from: dmy(addDays(-1)), to: dmy(addDays(-1)) };
  if (v.preset === 'tomorrow') return { view: 'range', from: dmy(addDays(1)), to: dmy(addDays(1)) };
  if (v.preset === 'day') return { view: 'range', from: v.from, to: v.from };
  return { view: 'range', from: v.from, to: v.to };
}
export function dateText(v) {
  if (v.preset === 'today') return 'Today\'s queue';
  if (v.preset === 'yesterday') return 'Billing yesterday';
  if (v.preset === 'tomorrow') return 'Billing tomorrow';
  if (v.preset === 'day') return `Billing ${shortDate(v.from)}`;
  return `Billing ${shortDate(v.from)} – ${shortDate(v.to)}`;
}

export function DateFilter({ value, onChange }) {
  const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['tomorrow', 'Tomorrow'], ['day', 'Day'], ['range', 'Range']];
  const set = (patch) => onChange({ ...value, ...patch });
  const pick = (preset) => set({ preset, from: value.from || dmy(), to: value.to || dmy() });
  return (
    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
      <div className="flex w-full sm:w-auto rounded-lg border border-line bg-white p-0.5">
        {presets.map(([k, label]) => (
          <button key={k} type="button" onClick={() => pick(k)}
            className={cx('h-8 flex-1 sm:flex-none px-1.5 sm:px-3 rounded-md text-xs font-medium whitespace-nowrap transition', value.preset === k ? 'bg-brand-sky text-brand-deep' : 'text-ink-60 hover:text-ink')}>
            {label}
          </button>
        ))}
      </div>
      {(value.preset === 'day' || value.preset === 'range') && (
        <input type="date" aria-label="From" className={cx(inputCls.replace('w-full ', ''), 'h-9 flex-1 min-w-0 sm:flex-none')} value={toIso(value.from)} max={isoDay(addDays(60))}
          onChange={e => e.target.value && set({ from: toDmy(e.target.value), to: value.preset === 'day' ? toDmy(e.target.value) : value.to })} />
      )}
      {value.preset === 'range' && <>
        <span className="text-ink-40 text-sm">to</span>
        <input type="date" aria-label="To" className={cx(inputCls.replace('w-full ', ''), 'h-9 flex-1 min-w-0 sm:flex-none')} value={toIso(value.to)} min={toIso(value.from)}
          onChange={e => e.target.value && set({ to: toDmy(e.target.value) })} />
      </>}
    </div>
  );
}

// Keeps a value for this browser tab; storage can be blocked, so it is best-effort.
export function useStored(key, initial) {
  const [v, setV] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(key)) ?? initial; } catch { return initial; }
  });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV];
}
