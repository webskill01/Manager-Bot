// Official WhatsApp Cloud API sender — one HTTPS POST, no SDK, no BSP.
//
// Why this exists: proactive payment-demand DMs on Baileys are the strongest ban signal
// there is. Meta's own API cannot get the number banned for sending them, and at ~22 due
// members a day the bill is roughly ₹90/month. Group ops (add/kick/approve) stay on
// Baileys forever — the Groups API only manages business-created groups capped at 8
// members, so it can never touch the real ones.
//
// Send-only by design (phase 1): no webhook, no inbound handling. The template tells the
// member to reply on the Baileys number they already message. Delivery receipts and
// quick-reply buttons need a public HTTPS endpoint and are deferred — see
// docs/superpowers/specs/FUTURE-IMPROVEMENTS.md.
//
// The registered number is NOT on the WhatsApp app and is NOT in any group. Members will
// see renewal messages arrive from a different number than the one running the groups.

// Meta retires a Graph version roughly two years after release, and a call to a retired one
// fails outright. v21.0 shipped in late 2024 and was close to the edge; v25.0 is what the
// console was serving in Aug 2026. Override per bot with cloudApi.apiVersion if this ages.
const GRAPH_VERSION = 'v25.0';

// Meta rejects template variables containing newlines, tabs, or 4+ consecutive spaces.
// Silently normalising here beats a 132000 error at 6:30 AM for a member whose name was
// pasted with a line break.
export function sanitizeParam(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
}

// Cloud API wants a bare international number, no '+', no spaces. Sheet phones are
// 10 digits; anything already carrying 91 is left alone.
export function toWaId(phone, countryCode = '91') {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `${countryCode}${digits}`;
  return digits;
}

export function buildTemplatePayload({ phone, templateName, languageCode = 'en', bodyParams = [], headerImageUrl = null, countryCode = '91' }) {
  const components = [];
  if (headerImageUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: headerImageUrl } }],
    });
  }
  if (bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(p => ({ type: 'text', text: sanitizeParam(p) })),
    });
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(phone, countryCode),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 ? { components } : {}),
    },
  };
}

// Each reminder stage is a SEPARATE approved template, because Meta approves body text, not
// intent: "your month is up, pay ₹90" and "last day before removal" cannot share one. Config
// carries them as cloudApi.templates.{reminder,referralReminder,overdue,finalReminder}, and
// falls back to the single cloudApi.templateName so an existing one-template setup still works.
export function templateFor(config, type) {
  const c = config?.cloudApi || {};
  return c.templates?.[type] || c.templateName || null;
}

export function isConfigured(config) {
  const c = config?.cloudApi;
  if (!c || !c.phoneNumberId || !c.token) return false;
  // One usable template name is the minimum. A `templates` object with nothing in it is not
  // configured — it would send `template: { name: null }` and eat a 132001 per member.
  return !!(c.templateName || Object.values(c.templates || {}).some(Boolean));
}

// True when this bot should route reminders through the official API rather than
// Baileys. Defaults to off, so nothing changes until the flag is flipped.
export function usesCloudApi(config) {
  return config?.reminderChannel === 'cloudapi' && isConfigured(config);
}

export function createCloudApiSender(config, log, { fetchImpl = globalThis.fetch } = {}) {
  const c = config.cloudApi || {};
  const endpoint = `https://graph.facebook.com/${c.apiVersion || GRAPH_VERSION}/${c.phoneNumberId}/messages`;

  // `type` selects an approved template by reminder stage ('reminder', 'referralReminder',
  // 'overdue', 'finalReminder'); an explicit templateName still wins over it.
  async function sendTemplate({ phone, templateName, type, bodyParams = [], languageCode, headerImageUrl }) {
    if (!isConfigured(config)) {
      return { ok: false, error: 'cloudApi not configured (need phoneNumberId, token, and a template name)' };
    }

    const resolved = templateName || (type ? templateFor(config, type) : null) || c.templateName;
    if (!resolved) {
      return { ok: false, error: `no Cloud API template configured for "${type || 'default'}" — set cloudApi.templates.${type || 'reminder'}` };
    }

    const payload = buildTemplatePayload({
      phone,
      templateName: resolved,
      languageCode: languageCode || c.languageCode || 'en',
      bodyParams,
      headerImageUrl: headerImageUrl ?? c.headerImageUrl ?? null,
      countryCode: c.countryCode || '91',
    });

    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Network failure: the caller decides whether to retry or fall back to Baileys.
      log.warn(`⚠️  Cloud API request failed for ${phone}: ${err.message}`);
      return { ok: false, error: err.message, retryable: true };
    }

    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error page */ }

    if (!res.ok) {
      const detail = body?.error?.message || `HTTP ${res.status}`;
      const code = body?.error?.code;
      // 4xx other than 429 means the request itself is wrong (bad template, unregistered
      // recipient, expired token) — retrying sends the same broken request again.
      const retryable = res.status === 429 || res.status >= 500;
      log.warn(`⚠️  Cloud API rejected ${phone}: ${detail}${code ? ` [code ${code}]` : ''}`);
      return { ok: false, error: detail, code, status: res.status, retryable };
    }

    const messageId = body?.messages?.[0]?.id || null;
    log.info(`📨 Cloud API template "${payload.template.name}" → ${payload.to}${messageId ? ` (${messageId})` : ''}`);
    return { ok: true, messageId, to: payload.to };
  }

  return { sendTemplate, endpoint };
}
