let onLoggedOut = () => {};
export const whenLoggedOut = (fn) => { onLoggedOut = fn; };

// Every mutation is sent as JSON: the server refuses anything else (CSRF guard).
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') onLoggedOut();
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

// Lists go as one comma value (bot=a,b); empty ones are dropped.
export const qs = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
