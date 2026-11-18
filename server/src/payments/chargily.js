/**
 * محوّل Chargily Pay v2 — المزوّد الجزائري (EDAHABIA / CIB / تطبيق Chargily).
 * الوثائق: https://dev.chargily.com/pay-v2
 *
 * ✅ مُطابِق للـAPI الحقيقية (تحقّقنا من الوثائق):
 *  • المبلغ integer بالدينار (currency: 'dzd').
 *  • توقيع الـWebhook = HMAC-SHA256 على **الجسم الخام** بمفتاح **API Secret Key**
 *    (لا يوجد سرّ مستقل للـWebhook — من يضع سرًّا آخر يفشل تحقّقه دائمًا).
 *  • الأحداث: checkout.paid / checkout.failed / checkout.canceled / checkout.expired.
 *  • لا توجد واجهة استرداد (Refund) في v2 ⇒ الاسترداد يدوي من لوحة Chargily.
 *  • التأكيد يصل عبر Webhook؛ ونضيف مسارًا احتياطيًا: GET /checkouts/:id عند صفحة النجاح.
 */
import crypto from 'node:crypto';
import { ENV } from '../config.js';

export const provider = 'chargily';
export const supportsServerConfirm = false;        // التأكيد عبر Webhook (+ مسار استعلام احتياطي)
export const supportsRefundApi = false;            // الاسترداد يدوي في لوحة Chargily

const base = () => ENV.chargilyTest
  ? 'https://pay.chargily.net/test/api/v2'
  : 'https://pay.chargily.net/api/v2';

/** أقل مبلغ مقبول لدى Chargily */
export const MIN_DZD = 75;

async function call(path, body, method = 'POST') {
  if (!ENV.chargilyKey) throw new Error('CHARGILY_SECRET_KEY غير مضبوط');
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${ENV.chargilyKey}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Chargily ${res.status}: ${JSON.stringify(json).slice(0, 250)}`);
  return json;
}

/** تحويل العملة إلى دينار (Chargily يعمل بالدينار فقط) */
export const toDzd = (amount, currency) => {
  const n = Number(amount);
  if (String(currency).toLowerCase() === 'dzd') return Math.round(n);
  return Math.round(n * Number(ENV.dzdPerUsd || 135));
};

/** يبني جسم إنشاء الـcheckout — دالة نقية قابلة للاختبار */
export function buildCheckoutPayload({ amount, currency = 'USD', bookingId, method = 'edahabia' }) {
  const dzd = toDzd(amount, currency);
  if (dzd < MIN_DZD) throw new Error(`أقل مبلغ للدفع الإلكتروني ${MIN_DZD} دج (المطلوب ${dzd} دج)`);
  const paymentMethod = ['edahabia', 'cib', 'chargily_app'].includes(method) ? method : 'edahabia';
  return {
    amount: dzd,
    currency: 'dzd',
    payment_method: paymentMethod,
    success_url: `${(ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port))}/pay/success?booking=${bookingId || ''}`,
    failure_url: `${(ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port))}/pay/failure?booking=${bookingId || ''}`,
    webhook_endpoint: `${(ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port))}/webhooks/chargily`,
    description: `ماريا — حجز ${bookingId || ''}`,
    locale: 'ar',
    /* نحن نتحمّل رسوم Chargily — لا نضيفها للعميل خفية */
    chargily_pay_fees_allocation: ENV.chargilyFeesAllocation || 'merchant',
    metadata: { booking_id: bookingId || '' },
  };
}

export async function createIntent({ amount, currency = 'USD', bookingId, method = 'edahabia' }) {
  const payload = buildCheckoutPayload({ amount, currency, bookingId, method });
  const checkout = await call('/checkouts', payload);
  return {
    providerRef: checkout.id,
    clientSecret: null,
    status: 'requires_action',
    requiresAction: true,
    amountDzd: payload.amount,
    nextAction: { type: 'redirect', url: checkout.checkout_url },
  };
}

/** لا يوجد تأكيد خادمي مباشر — يُرفض بوضوح */
export async function confirm() {
  throw new Error('Chargily يؤكّد الدفع عبر Webhook — لا يمكن التأكيد من الخادم');
}

/** استعلام حالة checkout (مسار التأكيد الاحتياطي عند صفحة النجاح) */
export async function getCheckout(checkoutId) {
  const c = await call(`/checkouts/${encodeURIComponent(checkoutId)}`, null, 'GET');
  return { id: c.id, status: c.status, paid: c.status === 'paid', amount: c.amount, currency: c.currency, metadata: c.metadata };
}

/** إلغاء/إفساد checkout معلّق (متاح في v2) */
export async function expireCheckout(checkoutId) {
  const c = await call(`/checkouts/${encodeURIComponent(checkoutId)}/expire`, {});
  return { id: c.id, status: c.status };
}

/**
 * استرداد: لا توجد واجهة في Chargily Pay v2.
 * نُرجع حالة صريحة ليتولّى التشغيلُ الاسترداد اليدوي من اللوحة — بدل إيهام بنجاح وهمي.
 */
export async function refund({ providerRef, amount }) {
  if (!providerRef) throw new Error('معرّف checkout مطلوب');
  let status = null;
  try { status = (await getCheckout(providerRef)).status; } catch { /* تجاهل */ }
  return {
    status: 'manual_required',
    providerRef,
    amount,
    gatewayStatus: status,
    message: 'Chargily Pay v2 لا يوفّر واجهة استرداد: نفّذ الاسترداد من لوحة Chargily ثم سجّل المرجع في المنصة',
  };
}

/**
 * تحقّق توقيع الـWebhook.
 * المفتاح الصحيح = API Secret Key (حسب وثائق Chargily).
 * `secret` الصريح يُستخدم للاختبارات فقط.
 */
export function verifyWebhook(rawBody, signature, secret = null) {
  const key = secret || ENV.chargilyKey || ENV.chargilyWebhookSecret || '';
  if (!key) return { ok: false, reason: 'مفتاح Chargily غير مضبوط (CHARGILY_SECRET_KEY)' };
  if (!signature) return { ok: false, reason: 'لا توجد ترويسة signature' };
  const expected = crypto.createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true, keySource: secret ? 'explicit' : (ENV.chargilyKey ? 'api-key' : 'legacy-webhook-secret') } : { ok: false, reason: 'توقيع غير مطابق' };
}

/** أنواع الأحداث المدعومة */
export const EVENTS = ['checkout.paid', 'checkout.failed', 'checkout.canceled', 'checkout.expired'];
