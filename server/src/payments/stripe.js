/**
 * مزوّد Stripe — نداءات REST مباشرة (بلا SDK).
 * يتطلّب: STRIPE_SECRET_KEY (و STRIPE_WEBHOOK_SECRET لتحقّق الـWebhook).
 *
 * ملاحظة مهمّة: لا نمرّر بيانات البطاقة عبر خادمنا أبدًا.
 * الواجهة تستعمل Stripe.js + clientSecret، والتحقّق يحدث عند Stripe (3DS/SCA).
 */
import crypto from 'node:crypto';
import { ENV } from '../config.js';

export const provider = 'stripe';
export const supportsServerConfirm = false;

const API = 'https://api.stripe.com/v1';

const form = (obj, prefix = '', out = []) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
};

async function call(path, bodyObj, method = 'POST') {
  if (!ENV.stripeSecret) throw new Error('STRIPE_SECRET_KEY غير مضبوط');
  const body = form(bodyObj || {}).join('&');
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${ENV.stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message || 'error'}`);
  return json;
}

export async function createIntent({ amount, currency = 'USD', bookingId, method = 'card' }) {
  const pi = await call('/payment_intents', {
    amount: Math.round(Number(amount) * 100),      // بالسنت
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { bookingId: bookingId || '', model: 'maria-3pct' },
  });
  return {
    providerRef: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,                              // requires_payment_method | requires_confirmation…
    requiresAction: pi.status !== 'succeeded',
  };
}

/** الاسترجاع من Stripe هو مصدر الحقيقة، لا نثق بحالة محلية */
export async function retrieve({ providerRef }) {
  const pi = await call(`/payment_intents/${providerRef}`, null, 'GET');
  return { status: pi.status, amount: pi.amount / 100 };
}

export async function confirm() {
  throw new Error('مع Stripe يتم التأكيد في المتصفح عبر Stripe.js ثم يصلك Webhook — لا تُؤكَّد من الخادم هنا');
}

export async function refund({ providerRef, amount }) {
  const r = await call('/refunds', {
    payment_intent: providerRef,
    amount: Math.round(Number(amount) * 100),
  });
  return { status: r.status === 'succeeded' ? 'refunded' : 'pending', providerRef: r.id };
}

/**
 * تحقّق توقيع Webhook بالطريقة الرسمية:
 * signed_payload = `${timestamp}.${rawBody}` ، ثم HMAC-SHA256 بالسر، ومقارنة زمنية آمنة.
 */
export function verifyWebhook(rawBody, signatureHeader, secret = ENV.stripeWebhookSecret) {
  if (!secret || !signatureHeader) return { ok: false, reason: 'إعداد ناقص' };
  const parts = signatureHeader.split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    (acc[k] = acc[k] || []).push(v);
    return acc;
  }, {});
  const timestamp = Number(parts.t?.[0]);
  if (!timestamp) return { ok: false, reason: 'لا يوجد timestamp' };
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return { ok: false, reason: 'التوقيع قديم (replay)' };

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const ok = (parts.v1 || []).some((sig) => {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return ok ? { ok: true } : { ok: false, reason: 'توقيع غير مطابق' };
}
