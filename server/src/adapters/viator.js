/**
 * محوّل Viator — الأنشطة والترفيه.
 * الوثائق: https://docs.viator.com/partner-api/technical/
 *
 * بحث حقيقي: POST {base}/products/search
 *   headers: exp-api-key, Accept: application/json;version=2.0, Accept-Language
 * وضع الحجز: نموذج "handoff" — إحالة إلى Viator مع معرّفات التتبّع (pid/mcid)،
 *           لأن إتمام الحجز داخل Viator يتطلّب صلاحية Booking Affiliate.
 *           تُقيَّد العمولة بعد استلام تقرير Viator (أسبوعي) عبر /api/reconcile.
 */
import { ENV, hasViator } from '../config.js';
import * as mock from './mock.js';

export const capabilities = () => ({
  provider: 'viator',
  live: hasViator(),
  booking: false, // handoff فقط
  note: hasViator()
    ? 'متصل بـ Viator (بحث حقيقي) · الحجز يتم بالإحالة مع تتبّع العمولة'
    : 'وضع تجريبي — أضف VIATOR_API_KEY لتفعيل البحث الحقيقي',
});

export async function search({ destination = 'Paris', currency = 'USD', searchTerm } = {}) {
  if (!hasViator()) {
    const offers = await mock.search({ vertical: 'activity' });
    return offers.map(o => ({ ...o, source: 'mock(fallback)' }));
  }

  const res = await fetch(ENV.viatorBaseUrl + '/products/search', {
    method: 'POST',
    headers: {
      'exp-api-key': ENV.viatorKey,
      'Content-Type': 'application/json',
      Accept: 'application/json;version=2.0',
      'Accept-Language': 'ar',
    },
    body: JSON.stringify({
      searchTerm: searchTerm || destination,
      currency,
      pagination: { start: 1, count: 12 },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Viator search ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const products = json?.products?.results || json?.products || [];

  return (Array.isArray(products) ? products : []).map((p) => ({
    id: 'vt_' + (p.productCode || p.code),
    vertical: 'activity',
    source: 'viator',
    title: p.title || 'تجربة',
    subtitle: (p.description || '').slice(0, 90) || 'نشاط سياحي',
    tags: [
      p.reviews?.combinedAverageRating ? '★ ' + p.reviews.combinedAverageRating : null,
      p.reviews?.totalReviews ? `${p.reviews.totalReviews} تقييم` : null,
      'إحالة مع تتبّع العمولة',
    ].filter(Boolean),
    price: Number(p.pricing?.summary?.fromPrice || p.pricing?.refundableFrom || 0),
    currency,
    supplierRef: p.productCode || p.code,
    // رابط الإحالة: Viator يضيف معرّفات التتبّع (pid/mcid) تلقائيًا عند وجودها في حسابك
    handoffUrl: p.productUrl || null,
    bookable: false,
  })).filter(o => o.price > 0);
}

/**
 * الحجز عبر الإحالة: نعيد رابط الإحالة + نُسجّل "نية حجز" (click-out) لتُطابق لاحقًا.
 */
export async function book({ offer, ref }) {
  return {
    status: 'referred',
    providerRef: offer?.supplierRef || null,
    handoffUrl: offer?.handoffUrl || null,
    note: 'أُحيل العميل إلى Viator — تُقيَّد العمولة بعد تأكيد التقرير الأسبوعي',
    trackingRef: ref || null,
  };
}
