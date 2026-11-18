/**
 * محوّل Duffel — الطيران (حجز حقيقي في بيئة الإنتاج).
 * الوثائق: https://duffel.com/docs · api.duffel.com
 *
 * الإعداد:
 *   DUFFEL_API_KEY=duffel_test_xxx     (اختبار، مجاني)
 *   MARIA_MODE=live                     (لتفعيل المسار الحقيقي)
 *   DUFFEL_BASE_URL=…                    (للمحاكي المحلي فقط)
 *
 * ضمانات مبرمجة هنا:
 *  • Idempotency-Key على كل طلب إنشاء ⇒ لا حجز مزدوج عند إعادة المحاولة.
 *  • تحقّق مسبق من بيانات المسافر ⇒ رسالة عربية واضحة قبل إرسال أي طلب.
 *  • تحويل أخطاء Duffel إلى رسائل مفهومة (عرض منتهٍ، رصيد غير كافٍ، بطاقة مرفوضة…).
 *  • لا نلمس بيانات الدفع: نحن ندفع من رصيد Duffel (balance) بعد أن دفع العميل لنا.
 */
import crypto from 'node:crypto';
import { ENV, hasDuffel } from '../config.js';
import * as mock from './mock.js';

const H = (idempotencyKey = null) => ({
  Authorization: `Bearer ${ENV.duffelKey}`,
  'Duffel-Version': ENV.duffelVersion,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 100) } : {}),
});

/** نوع المفتاح: اختبار أم إنتاج */
export function keyMode() {
  const k = String(ENV.duffelKey || '');
  if (k.startsWith('duffel_test_')) return 'test';
  if (k.startsWith('duffel_live_')) return 'live';
  return k ? 'unknown' : 'none';
}

export const capabilities = () => ({
  provider: 'duffel',
  live: hasDuffel(),
  booking: hasDuffel(),
  keyMode: keyMode(),
  baseUrl: ENV.duffelBaseUrl,
  note: hasDuffel()
    ? `متصل بـ Duffel (${keyMode() === 'live' ? 'إنتاج حقيقي' : 'بيئة اختبار'})`
    : 'وضع تجريبي — أضف DUFFEL_API_KEY و MARIA_MODE=live لتفعيل الحجز الحقيقي',
});

/* ═══════════════ أخطاء مفهومة بدل نصوص خام ═══════════════ */
const ERRORS = {
  offer_no_longer_available: 'انتهت صلاحية هذا العرض أو تغيّر سعره — أعد البحث واختر عرضًا جديدًا',
  insufficient_balance: 'رصيد Duffel غير كافٍ — اشحن الرصيد من لوحة Duffel قبل الحجز',
  airline_insufficient_balance: 'شركة الطيران رفضت الحجز — حاول عرضًا آخر',
  validation_error: 'بيانات الحجز غير مكتملة أو غير صحيحة',
  passenger_identity_documents_required: 'هذا الخط يتطلّب وثيقة سفر (رقم جواز) للمسافر',
  duplicate: 'تم إنشاء هذا الطلب مسبقًا',
  not_found: 'العرض أو الطلب غير موجود لدى Duffel',
  airline_error: 'خطأ من شركة الطيران — أعد المحاولة أو اختر عرضًا آخر',
  schedule_changed: 'تغيّر جدول الرحلة أثناء الحجز — أعد البحث',
};

function mapError(status, json) {
  const first = json?.errors?.[0] || {};
  const code = first.code || (status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'unknown');
  const ar = ERRORS[code] || first.message || 'خطأ من مزوّد الطيران';
  const err = new Error(`Duffel[${status}] ${ar}`);
  err.statusCode = status === 422 ? 409 : status === 404 ? 404 : 502;
  err.providerCode = code;
  err.providerMessage = first.message || null;
  err.retryable = ['airline_error', 'unknown'].includes(code);
  return err;
}

async function request(path, { method = 'POST', body = null, idempotencyKey = null, timeout = 25000 } = {}) {
  if (!hasDuffel()) throw Object.assign(new Error('Duffel غير مفعّل: أضف DUFFEL_API_KEY و MARIA_MODE=live'), { statusCode: 503 });
  const res = await fetch(ENV.duffelBaseUrl + path, {
    method,
    headers: H(idempotencyKey),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw mapError(res.status, json);
  return json;
}

/* ═══════════════ البحث ═══════════════ */

export async function search({ origin = 'ALG', destination = 'CDG', departureDate = '2026-11-12', adults = 1, cabin = 'economy' } = {}) {
  if (!hasDuffel()) {
    const offers = await mock.search({ vertical: 'flight' });
    return offers.map(o => ({ ...o, source: 'mock(fallback)' }));
  }

  const json = await request('/air/offer_requests?return_offers=true', {
    body: {
      data: {
        slices: [{ origin, destination, departure_date: departureDate }],
        passengers: Array.from({ length: Math.max(1, adults) }, () => ({ type: 'adult' })),
        cabin_class: cabin,
      },
    },
  });

  const offers = json?.data?.offers || [];
  return offers.slice(0, 12).map((o) => {
    const slice = o.slices?.[0] || {};
    const segs = slice.segments || [];
    const stops = Math.max(0, segs.length - 1);
    const from = segs[0]?.origin?.iata_code || '?';
    const to = segs[segs.length - 1]?.destination?.iata_code || '?';
    const dur = (slice.duration || '').replace('PT', '').toLowerCase();
    const bag = (o.slices || [])
      .flatMap(s => s.segments || [])
      .flatMap(s => s.passengers || [])
      .flatMap(p => p.baggages || [])
      .find(b => b.type === 'checked');
    return {
      id: 'df_' + o.id,
      vertical: 'flight',
      source: 'duffel',
      title: `${from} ← ${to}`,
      subtitle: `${o.owner?.name || 'شركة طيران'} · ${stops === 0 ? 'مباشرة' : 'توقف ' + stops}`,
      tags: [dur, stops === 0 ? 'مباشرة' : `توقف ${stops}`, o.total_currency, bag ? `حقيبة ${bag.quantity}` : null].filter(Boolean),
      price: Number(o.total_amount),
      currency: o.total_currency,
      supplierRef: o.id,                 // معرّف Duffel الأصلي — يُستعمل في الطلب
      expiresAt: o.expires_at || null,
      refundable: Boolean(o.conditions?.refund_before_departure?.allowed),
      changeable: Boolean(o.conditions?.change_before_departure?.allowed),
      bookable: true,
      live: Boolean(o.live_mode),
    };
  });
}

/** استرجاع عرض محدّد (للتحقّق قبل الحجز إن كان قديمًا) */
export async function getOffer(offerId) {
  if (!hasDuffel()) return null;
  const json = await request('/air/offers/' + encodeURIComponent(offerId), { method: 'GET' });
  return {
    supplierRef: json?.data?.id,
    price: Number(json?.data?.total_amount),
    currency: json?.data?.total_currency,
    expiresAt: json?.data?.expires_at || null,
    live: Boolean(json?.data?.live_mode),
  };
}

/* ═══════════════ الحجز ═══════════════ */

/** يتحقّق من بيانات المسافر ويعيد صيغة Duffel الصحيحة */
function toDuffelPassengers(passengers = [], { email, phone } = {}) {
  if (!Array.isArray(passengers) || !passengers.length) {
    throw Object.assign(new Error('بيانات المسافر مطلوبة (الاسم، تاريخ الميلاد، الجنس)'), { statusCode: 422, field: 'passengers' });
  }
  return passengers.map((p, i) => {
    const given = p.given_name || p.name?.given_name || (p.name && String(p.name).split(' ')[0]);
    const family = p.family_name || p.name?.family_name || (p.name && String(p.name).split(' ').slice(1).join(' '));
    const missing = [];
    if (!given) missing.push('الاسم الشخصي');
    if (!family) missing.push('اسم العائلة');
    if (!p.born_on) missing.push('تاريخ الميلاد (YYYY-MM-DD)');
    if (!p.gender) missing.push('الجنس (m/f)');
    if (missing.length) {
      throw Object.assign(new Error(`المسافر ${i + 1}: ناقص ${missing.join(' · ')}`), { statusCode: 422, field: 'passengers', missing });
    }
    return {
      type: p.type || 'adult',
      title: p.title || (p.gender === 'f' ? 'ms' : 'mr'),
      given_name: String(given).trim(),
      family_name: String(family).trim(),
      born_on: p.born_on,
      gender: p.gender,
      email: p.email || email || undefined,
      phone_number: p.phone_number || phone || undefined,
      ...(p.identity_document ? { identity_documents: [p.identity_document] } : {}),
    };
  });
}

/**
 * إنشاء طلب Duffel حقيقي.
 * @param {{offer:object, passengers:array, amount:number, currency:string, idempotencyKey?:string, customer?:object}} args
 */
export async function book({ offer, passengers, amount, currency = 'USD', idempotencyKey = null, customer = {} }) {
  if (!hasDuffel()) {
    return { status: 'confirmed', providerRef: 'SIM-' + Math.random().toString(36).slice(2, 8).toUpperCase(), simulated: true };
  }
  const offerRef = offer?.supplierRef;
  if (!offerRef) throw Object.assign(new Error('عرض غير صالح للحجز (لا معرّف مزوّد)'), { statusCode: 422 });

  /* بيانات المسافر أولًا: أدقّ رسالة للمستخدم */
  const pax = toDuffelPassengers(passengers, { email: customer.email, phone: customer.phone });
  if (!(amount > 0)) throw Object.assign(new Error('مبلغ غير صالح'), { statusCode: 422 });
  const key = idempotencyKey || 'maria-' + crypto.randomUUID();

  const json = await request('/air/orders', {
    idempotencyKey: key,
    timeout: 45000,
    body: {
      data: {
        type: 'instant',
        selected_offers: [offerRef],
        passengers: pax,
        payments: [{ type: 'balance', amount: String(Number(amount).toFixed(2)), currency }],
        metadata: { platform: 'maria', reference: String(offer.id || '') },
      },
    },
  });

  const d = json?.data || {};
  return {
    status: d.status === 'confirmed' ? 'confirmed' : (d.status || 'pending'),
    providerRef: d.booking_reference || d.id || null,   // ما يعرضه العميل في المطار
    providerStatus: d.status || null,
    orderId: d.id || null,
    totalAmount: d.total_amount ? Number(d.total_amount) : null,
    currency: d.total_currency || currency,
    passengers: (d.passengers || []).length,
    documents: (d.documents || []).length,             // تذاكر/قسائم
    idempotencyKey: key,
  };
}

/** حالة الطلب من Duffel (للمطابقة مع حالتنا) */
export async function getOrder(orderId) {
  const json = await request('/air/orders/' + encodeURIComponent(orderId), { method: 'GET' });
  const d = json?.data || {};
  return {
    orderId: d.id,
    providerRef: d.booking_reference || null,
    status: d.status,
    totalAmount: d.total_amount ? Number(d.total_amount) : null,
    currency: d.total_currency,
    cancelledAt: d.cancelled_at || null,
  };
}

/**
 * إلغاء طلب لدى Duffel.
 * يعيد نوع الإلغاء (فوري/طلب) والمبلغ المسترد إن توفّر.
 */
export async function cancelOrder(orderId) {
  const json = await request('/air/orders/' + encodeURIComponent(orderId) + '/actions/cancel', {
    body: { data: {} },
    timeout: 30000,
  });
  const d = json?.data || {};
  const refund = Number(d.refund_amount || 0);
  return {
    status: d.status || 'cancelled',
    cancelledAt: d.cancelled_at || new Date().toISOString(),
    refundAmount: refund > 0 ? refund : 0,
    refundCurrency: d.refund_currency || null,
    refundTo: d.refund_to || null,
  };
}
