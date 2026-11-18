/**
 * طلبات الحجز — «العميل يطلب، ونحن نؤكّد».
 *
 * لماذا هذا هو الوضع الافتراضي؟
 *  • لا نخصم من العميل قبل التأكّد من توفّر الخدمة عند المزوّد.
 *  • الطيران/الفنادق تتغيّر أسعارها في ثوانٍ — الطلب يمنع بيع سعر منتهٍ.
 *  • العميل لا يترك بطاقته عندنا بلا مقابل: يدفع فقط بعد موافقتك.
 *
 * الدورة:
 *   new ──(موافقة)──► approved ──► (دفع) ──► booking.confirmed
 *     └──(رفض)──► rejected
 *     └──(٤٨ ساعة بلا رد)──► expired
 */
import crypto from 'node:crypto';
import { ENV, VERTICALS } from './config.js';
import * as repo from './db/repo.js';
import * as notify from './notify.js';
import * as core from './ledger.js';

const getCachedOffer = (id) => core.getCachedOffer(id);

const base = () => (ENV.publicBaseUrl || ENV.publicBaseUrlAuto || `http://localhost:${ENV.port}`).replace(/\/$/, '');

function newCode() {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return 'RQ-' + s;
}

/* ═══════════════ إنشاء طلب ═══════════════ */

export async function createRequest({ offerId, customer = {}, note = null, passengers = null, ref = null }) {
  const offer = getCachedOffer(offerId);
  if (!offer) throw Object.assign(new Error('انتهت صلاحية العرض — أعد البحث واختر من جديد'), { statusCode: 409 });

  const email = String(customer.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    throw Object.assign(new Error('البريد الإلكتروني مطلوب وصحيح — عليه سيصل تأكيد الطلب'), { statusCode: 422, field: 'email' });
  }
  if (!customer.name || String(customer.name).trim().length < 3) {
    throw Object.assign(new Error('الاسم الكامل مطلوب'), { statusCode: 422, field: 'name' });
  }
  const phone = String(customer.phone || '').replace(/[^\d+]/g, '');
  if (phone.length < 9) {
    throw Object.assign(new Error('رقم الهاتف مطلوب (للتأكيد عبر واتساب/الهاتف)'), { statusCode: 422, field: 'phone' });
  }

  const partner = ref ? await repo.getPartner(String(ref).toUpperCase()) : null;
  if (ref && !partner) throw Object.assign(new Error('كود شريك غير معروف'), { statusCode: 400 });

  let code = newCode();
  for (let tries = 0; tries < 5 && await repo.getRequest(code); tries++) code = newCode();

  const rec = await repo.createRequest({
    id: 'rq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    code,
    vertical: offer.vertical,
    offer: {
      id: offer.id, title: offer.title, subtitle: offer.subtitle, source: offer.source,
      supplierRef: offer.supplierRef || null, price: offer.price, currency: offer.currency || 'USD',
      expiresAt: offer.expiresAt || null,
    },
    customer: { name: String(customer.name).trim(), email, phone },
    note: note ? String(note).slice(0, 500) : null,
    passengers,
    ref: partner ? partner.code : ENV.platformCode,
  });

  await repo.addAudit('request.created', { code, vertical: offer.vertical, ref: rec.ref });

  /* بريد للعميل + تنبيه لك */
  notify.notifyRequestReceived(rec, { trackingUrl: `${base()}/request?code=${code}` }).catch(() => {});
  notify.notifyAdminNewRequest(rec, { dashboardUrl: `${base()}/dashboard` }).catch(() => {});

  return publicView(rec);
}

/* ═══════════════ قراءة ═══════════════ */

export function publicView(r) {
  if (!r) return null;
  return {
    code: r.code,
    status: r.status,
    vertical: r.vertical,
    verticalName: VERTICALS[r.vertical]?.name || r.vertical,
    offer: { title: r.offer?.title, subtitle: r.offer?.subtitle },
    customerName: String(r.customer?.name || '').split(' ')[0],
    note: r.note,
    adminNote: r.adminNote || null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    bookingId: r.bookingId || null,
    payUrl: r.status === 'approved' ? (r.payUrl || null) : null,
  };
}

export async function getByCode(code) {
  const r = await repo.getRequest(String(code || '').trim().toUpperCase());
  if (!r) return null;
  const v = publicView(r);
  /* إن دُفع الحجز: نُظهر ذلك ونُخفي زر الدفع */
  if (r.status === 'approved' && r.booking_id) {
    const pm = await repo.getPaymentByBooking(r.booking_id);
    if (pm && pm.status === 'succeeded') {
      v.status = 'paid';
      v.payUrl = null;
      v.paidAt = pm.updated_at || null;
    }
  }
  return v;
}

export async function listRequests({ status = null, limit = 100 } = {}) {
  const rows = await repo.listRequests({ status, limit });
  return rows.map(r => ({
    ...r,
    elapsedHours: Math.round((Date.now() - new Date(r.createdAt).getTime()) / 3600000),
    expiresInHours: Math.max(0, ENV.requestTtlHours - Math.round((Date.now() - new Date(r.createdAt).getTime()) / 3600000)),
  }));
}

export async function summary() {
  const counts = await repo.countRequests();
  return { mode: ENV.bookingMode, ttlHours: ENV.requestTtlHours, counts };
}

/* ═══════════════ القرار: موافقة ═══════════════ */

export async function approveRequest(idOrCode, { adminNote = null, method = 'card', passengers = null } = {}) {
  const r = await repo.getRequest(idOrCode);
  if (!r) throw Object.assign(new Error('طلب غير موجود'), { statusCode: 404 });
  if (r.status === 'approved' && r.booking_id) {
    const booking = await repo.getBooking(r.booking_id);
    return { request: publicView(r), booking, already: true };
  }
  if (r.status !== 'new') {
    throw Object.assign(new Error(`لا يمكن الموافقة على طلب حالته «${r.status}»`), { statusCode: 409 });
  }

  /* العرض قد يكون انتهى: نطلب من العميل إعادة الاختيار بدل بيع سعر قديم */
  const cached = getCachedOffer(r.offer?.id);
  if (!cached) {
    const upd = await repo.updateRequest(r.id, {
      status: 'expired',
      adminNote: (adminNote ? adminNote + ' · ' : '') + 'انتهت صلاحية العرض قبل الموافقة',
      decidedAt: new Date().toISOString(),
    });
    throw Object.assign(new Error('انتهت صلاحية عرض هذا الطلب — أعد البحث أو اطلب من العميل اختيار عرض جديد'), { statusCode: 409, request: publicView(upd) });
  }

  const out = await core.createBooking({
    offerId: r.offer.id,
    ref: r.ref,
    customer: { name: r.customer.name, email: r.customer.email, phone: r.customer.phone },
    method,
  });

  const booking = out.booking;
  /* بيانات المسافر إن أُرسلت مع الطلب تُحفظ لتُستعمل عند الدفع */
  if (r.passengers?.length || passengers?.length) {
    await repo.updateBooking(booking.id, { passengers: JSON.stringify(passengers || r.passengers) });
  }

  /* رابط الدفع: بوابة خارجية (Chargily/Stripe) إن وُجدت، وإلا صفحتنا الداخلية */
  const nx = out.payment?.nextAction?.url || null;
  const payUrl = out.payment
    ? (/^https?:\/\//.test(nx || '') ? nx : `${base()}/pay?booking=${booking.id}`)
    : null;

  const upd = await repo.updateRequest(r.id, {
    status: 'approved', bookingId: booking.id, payUrl, adminNote, decidedAt: new Date().toISOString(),
  });
  await repo.addAudit('request.approved', { code: r.code, booking: booking.id });

  notify.notifyRequestApproved(upd, {
    booking,
    payUrl: payUrl ? (payUrl.startsWith('http') ? payUrl : base() + payUrl) : null,
  }).catch(() => {});

  return { request: publicView(upd), booking, payment: out.payment || null, already: false };
}

/* ═══════════════ القرار: رفض ═══════════════ */

export async function rejectRequest(idOrCode, { reason = 'الخدمة غير متوفّرة حاليًا على هذا الخط/التاريخ' } = {}) {
  const r = await repo.getRequest(idOrCode);
  if (!r) throw Object.assign(new Error('طلب غير موجود'), { statusCode: 404 });
  if (r.status !== 'new') throw Object.assign(new Error(`لا يمكن رفض طلب حالته «${r.status}»`), { statusCode: 409 });

  const upd = await repo.updateRequest(r.id, {
    status: 'rejected', adminNote: String(reason).slice(0, 300), decidedAt: new Date().toISOString(),
  });
  await repo.addAudit('request.rejected', { code: r.code, reason });
  notify.notifyRequestRejected(upd, reason).catch(() => {});
  return publicView(upd);
}

/** إلغاء من طرف العميل */
export async function cancelRequest(idOrCode, { email }) {
  const r = await repo.getRequest(idOrCode);
  if (!r) throw Object.assign(new Error('طلب غير موجود'), { statusCode: 404 });
  if (email && String(r.customer?.email).toLowerCase() !== String(email).toLowerCase()) {
    throw Object.assign(new Error('البريد لا يطابق صاحب الطلب'), { statusCode: 403 });
  }
  if (!['new', 'approved'].includes(r.status)) throw Object.assign(new Error('لا يمكن إلغاء هذا الطلب'), { statusCode: 409 });
  const upd = await repo.updateRequest(r.id, { status: 'cancelled', decidedAt: new Date().toISOString() });
  await repo.addAudit('request.cancelled', { code: r.code });
  return publicView(upd);
}

/** الطلبات القديمة تُغلق تلقائيًا — لا نُبقي العميل منتظرًا بلا نهاية */
export async function expireStale() {
  const rows = await repo.listRequests({ status: 'new', limit: 500 });
  const limitMs = ENV.requestTtlHours * 3600000;
  const expired = [];
  for (const r of rows) {
    if (Date.now() - new Date(r.createdAt).getTime() > limitMs) {
      await repo.updateRequest(r.id, {
        status: 'expired', decidedAt: new Date().toISOString(),
        adminNote: 'لم يُبتّ في الطلب خلال المدة المحدّدة',
      });
      notify.notifyRequestRejected(r, 'انتهت مدة الطلب قبل التأكيد — أعد الطلب وسنجيبك أسرع').catch(() => {});
      expired.push(r.code);
    }
  }
  return expired;
}
