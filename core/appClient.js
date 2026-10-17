// Read-only client for the EaseCab member-sync API (GET /api/v1/member-sync/*).
//
// APP_SYNC_URL is the API origin (e.g. https://api.easecab.in), APP_SYNC_TOKEN the shared
// x-token. Either missing → null, and every caller treats null as "app sync off", so a bot
// without the .env lines runs exactly as before.
const TIMEOUT_MS = 10_000;

export function createAppClient(config, fetchImpl = globalThis.fetch) {
  if (!config?.appSyncUrl || !config?.appSyncToken) return null;
  const base = config.appSyncUrl.replace(/\/+$/, '') + '/api/v1/member-sync';

  async function get(path, query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const res = await fetchImpl(`${base}${path}${qs.size ? `?${qs}` : ''}`, {
      headers: { 'x-token': config.appSyncToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      throw new Error(`app sync ${path} failed: HTTP ${res.status} ${body?.error?.code || ''}`.trim());
    }
    return { ...body.data, truncated: !!body.meta?.truncated };
  }

  return {
    // → { now, members: [{ phone, status, expiresAt, paidCount, lastPaidAt, lastAmount }], truncated }
    memberships({ since, phones } = {}) {
      return get('/memberships', { since: since?.toISOString?.() ?? since, phones: phones?.join(',') });
    },
    // → { payments: [{ phone, amount, paidAt, first }], truncated }
    payments({ from, to }) {
      return get('/payments', { from: from.toISOString(), to: to.toISOString() });
    },
  };
}
