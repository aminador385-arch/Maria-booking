/**
 * الخدمة الأساسية (Postgres):
 * بحث → تسعير 3% → نية دفع → تحقّق → حجز لدى المزوّد → قيد/تسوية → تحويلات
 *
 * مبادئ غير قابلة للتفاوض:
 *  1. لا حجز مؤكَّد بلا دفع ناجح (payment.status = 'succeeded').
 *  2. لا قيد عمولة قبل تأكيد المزوّد.
 *  3. كل تغيير حالة يُسجَّل في timeline + ledger (audit).
 *  4. الإلغاء بعد الدفع = استرداد فعلي + قيد عكس.
 */
import { MODEL, VERTICALS, ENV } from './config.js';
import { quote, round } from './pricing.js';
import * as repo from './db/repo.js';
import { pay, paymentInfo } from './payments/index.js';
import * as duffel from './adapters/duffel.js';
import * as viator from './adapters/viator.js';
import * as mock from './adapters/mock.js';
import { validateCcp, maskCcp, publicAccount, toDzd } from './ccp.js';
import * as notify from './notify.js';

const ADAPTERS = { duffel, viator, mock };

/* ---------------- آلة حالات الحجز ---------------- */
const TRANSITIONS = {
  pending:   ['confirmed', 'cancelled', 'referred'],
  referred:  ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'refunded', 'fulfilled'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded:  [],
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/* ---------------- كاش العروض (15 دقيقة) ---------------- */
const offersCache = new Map();
const cacheOffers = (offers) => {
  const exp = Date.now() + MODEL.offerTtlMinutes * 60 * 1000;
  offers.forEach(o => offersCache.set(o.id, { offer: o, expires: exp }));
};
export const getCachedOffer = (id) => {
  const row = offersCache.get(id);
  if (!row) return null;
  if (row.expires < Date.now()) { offersCache.delete(id); return null; }
  return row.offer;
};

/* =========================== البحث =========================== */
export async function search({ vertical, ref = null, params = {} }) {
  const v = VERTICALS[vertical];
  if (!v) throw Object.assign(new Error('قطاع غير معروف: ' + vertical), { statusCode: 400 });

  const adapter = ADAPTERS[v.adapter] || mock;
  let offers = [];
  let adapterInfo;
  try {
    offers = await adapter.search({ ...params, vertical });
    adapterInfo = adapter.capabilities ? adapter.capabilities() : { provider: v.adapter };
  } catch (err) {
    offers = (await mock.search({ vertical })).map(o => ({ ...o, source: 'mock(fallback)' }));
    adapterInfo = { provider: v.adapter, live: false, error: String(err.message || err) };
  }

  const affiliateMode = ENV.paymentProvider === 'none';
  const priced = offers.map(o => {
    const q = quote({ vertical, price: o.price, ref, affiliateMode });
    return { ...o, pricing: q, displayPrice: q.customerTotal };
  });
  cacheOffers(offers);
  return { vertical, verticalName: v.name, adapter: adapterInfo, offers: priced };
}

/* =========================== إنشاء حجز + نية دفع =========================== */
export async function createBooking({ offerId, ref = null, customer = {}, idempotencyKey = null, method = 'card' }) {
  /* idempotency */
  const prev = await repo.getIdem(idempotencyKey);
  if (prev) {
    const booking = await repo.getBooking(prev.booking_id);
    const payment = await repo.getPaymentByBooking(prev.booking_id);
    return { booking, payment, replayed: true };
  }

  const offer = getCachedOffer(offerId);
  if (!offer) throw Object.assign(new Error('انتهت صلاحية العرض — أعد البحث'), { statusCode: 409 });

  const code = ref ? String(ref).toUpperCase() : ENV.platformCode;
  const partner = await repo.getPartner(code);
  if (!partner) throw Object.assign(new Error('كود شريك غير معروف'), { statusCode: 400 });
  if (partner.status !== 'active') {
    throw Object.assign(new Error('حساب الشريك قيد المراجعة — لا يمكن البيع بعد'), { statusCode: 403 });
  }

  const affiliateMode = ENV.paymentProvider === 'none';
  const q = quote({ vertical: offer.vertical, price: offer.price, ref: code, affiliateMode });
  const id = 'bk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const booking = await repo.createBooking({
    id, ref: code, vertical: offer.vertical,
    offer: { id: offer.id, title: offer.title, subtitle: offer.subtitle, source: offer.source, supplierRef: offer.supplierRef || null, price: offer.price },
    customer: { name: customer.name || 'عميل', email: customer.email || null, phone: customer.phone || null },
    pricing: q,
    status: 'pending',
    timeline: [{ at: new Date().toISOString(), status: 'pending', note: 'بانتظار الدفع' }],
  });

  if (idempotencyKey) await repo.setIdem(idempotencyKey, id);
  await repo.addAudit('booking.created', { id, ref: code, vertical: offer.vertical, price: offer.price });

  /* قيد مستحق (pending) */
  await repo.addLedger({ bookingId: id, ref: code, type: 'accrual', status: 'pending', components: q });

  /* ═══ وضع الإحالة: لا دفع عندنا — العميل يُحال إلى المزوّد ═══ */
  if (affiliateMode) {
    const v = VERTICALS[offer.vertical];
    const adapter = ADAPTERS[v.adapter] || mock;
    let handoffUrl = offer.handoffUrl || null;
    let providerRef = offer.supplierRef || null;
    try {
      const r = await adapter.book({ offer: { ...offer, vertical: offer.vertical }, ref: code });
      handoffUrl = r.handoffUrl || handoffUrl;
      providerRef = r.providerRef || providerRef;
    } catch { /* لا نُسقط الحجز إن فشل تكوين رابط الإحالة */ }

    const referred = await setStatus(id, 'referred', 'إحالة إلى المزوّد — بانتظار مطابقة العمولة', {
      provider_ref: providerRef || null, handoff_url: handoffUrl || null,
    });
    return { booking: referred, payment: null, affiliate: true, replayed: false };
  }

  /* نية دفع — العميل يدفع السعر + 3% */
  const intent = await pay().createIntent({ amount: q.customerTotal, currency: q.currency, bookingId: id, method });
  const payment = await repo.createPayment({
    id: 'pm_' + Math.random().toString(36).slice(2, 10),
    bookingId: id, provider: pay().provider, providerRef: intent.providerRef,
    amount: q.customerTotal, currency: q.currency, status: intent.status,
    method, threeDs: Boolean(intent.requiresAction),
  });
  await repo.updateBooking(id, { payment_id: payment.id });

  return {
    booking: await repo.getBooking(id),
    payment: {
      id: payment.id, provider: payment.provider, amount: payment.amount, currency: payment.currency,
      status: payment.status, clientSecret: intent.clientSecret || null,
      requiresAction: Boolean(intent.requiresAction), nextAction: intent.nextAction || null,
    },
    replayed: false,
  };
}

/* =========================== تأكيد الدفع ثم تنفيذ الحجز =========================== */
export async function confirmPayment(paymentId, { threeDS = 'success', cardLast4 = null, passengers = [] } = {}) {
  const payment = await repo.getPayment(paymentId);
  if (!payment) throw Object.assign(new Error('دفعة غير موجودة'), { statusCode: 404 });
  if (payment.status === 'succeeded') {
    return { payment, booking: await repo.getBooking(payment.booking_id), idempotent: true };
  }

  if (pay().supportsServerConfirm === false) {
    return {
      payment, booking: await repo.getBooking(payment.booking_id), ok: false,
      pending: true,
      reason: 'هذا المزوّد يؤكّد الدفع عبر Webhook — انتظر إشعار الدفع',
    };
  }

  let result;
  try {
    result = await pay().confirm({ providerRef: payment.provider_ref, threeDS, cardLast4 });
  } catch (err) {
    result = { status: 'failed', failureReason: err.message };
  }

  if (result.status !== 'succeeded') {
    const failed = await repo.updatePayment(payment.id, { status: 'failed', failureReason: result.failureReason || 'فشل الدفع' });
    await repo.addLedger({ bookingId: payment.booking_id, type: 'payment_failed', status: 'reversed', reason: result.failureReason });
    await repo.addAudit('payment.failed', { paymentId, reason: result.failureReason });
    return { payment: failed, booking: await repo.getBooking(payment.booking_id), ok: false, reason: result.failureReason };
  }

  const ok = await repo.updatePayment(payment.id, { status: 'succeeded' });
  await repo.addAudit('payment.succeeded', { paymentId, bookingId: payment.booking_id, amount: payment.amount });

  const booking = await finalizeBooking(payment.booking_id, { passengers });
  return { payment: ok, booking, ok: true };
}

/* =========================== تنفيذ الحجز لدى المزوّد =========================== */
export async function finalizeBooking(bookingId, { passengers = [] } = {}) {
  const b = await repo.getBooking(bookingId);
  if (!b) throw Object.assign(new Error('حجز غير موجود'), { statusCode: 404 });
  if (['confirmed', 'referred', 'fulfilled'].includes(b.status)) return b;

  /* لا حجز بلا دفع ناجح */
  const payment = await repo.getPaymentByBooking(bookingId);
  if (!payment || payment.status !== 'succeeded') {
    throw Object.assign(new Error('لا يمكن تأكيد الحجز قبل نجاح الدفع'), { statusCode: 402 });
  }

  const v = VERTICALS[b.vertical];
  const adapter = ADAPTERS[v.adapter] || mock;
  let result;
  try {
    const cached = getCachedOffer(b.offer.id) || { ...b.offer, vertical: b.vertical };
    result = await adapter.book({
      offer: cached, passengers,
      amount: b.pricing.customerTotal, currency: b.pricing.currency, ref: b.ref,
      /* نفس الحجز ⇒ نفس مفتاح Idempotency ⇒ لا حجز مزدوج عند إعادة المحاولة */
      idempotencyKey: 'booking-' + b.id,
      customer: b.customer || {},
    });
  } catch (err) {
    /* فشل المزوّد بعد الدفع → استرداد كامل ثم إلغاء */
    await pay().refund({ providerRef: payment.provider_ref, amount: payment.amount }).catch(() => {});
    await repo.updatePayment(payment.id, { status: 'refunded', failureReason: 'تعذّر الحجز لدى المزوّد' });
    return setStatus(bookingId, 'cancelled', 'فشل المزوّد بعد الدفع — تم الاسترداد');
  }

  const booked = await setStatus(bookingId, result.status === 'referred' ? 'referred' : (result.status || 'confirmed'), null, {
    provider_ref: result.providerRef || null,
    provider_status: result.providerStatus || null,
    handoff_url: result.handoffUrl || null,
  });

  /* إشعار العميل — لا يُفشل الحجز إن فشل البريد */
  notify.notifyBooking(booked).catch(() => {});
  return booked;
}

/* =========================== تغيير الحالة + القيود =========================== */
export async function setStatus(id, status, reason = null, extra = {}) {
  const b = await repo.getBooking(id);
  if (!b) throw Object.assign(new Error('حجز غير موجود'), { statusCode: 404 });
  if (b.status === status) return b;
  if (!canTransition(b.status, status)) {
    throw Object.assign(new Error(`انتقال غير مسموح: ${b.status} → ${status}`), { statusCode: 409 });
  }

  const timeline = [...(b.timeline || []), { at: new Date().toISOString(), status, note: reason || null }];
  const updated = await repo.updateBooking(id, { ...extra, status, timeline });

  if (status === 'confirmed' || status === 'fulfilled') {
    await repo.addLedger({ bookingId: id, ref: b.ref, type: 'settle', status: 'earned', amount: b.pricing.platformNet, components: b.pricing });
  }
  if (status === 'cancelled' || status === 'refunded') {
    await repo.addLedger({ bookingId: id, ref: b.ref, type: 'reversal', status: 'reversed', amount: b.pricing.platformNet, components: b.pricing, reason });
  }
  await repo.addAudit('booking.status', { id, status, reason });
  return updated;
}

/** إلغاء مع استرداد فعلي إن كان مدفوعًا */
export async function cancelBooking(id, reason = 'إلغاء') {
  const b = await repo.getBooking(id);
  if (!b) throw Object.assign(new Error('حجز غير موجود'), { statusCode: 404 });
  const notes = [];

  /* 1) إلغاء لدى المزوّد أولًا (الطيران): لا نُعيد للعميل قبل تحرير المقعد */
  if (b.vertical === 'flight' && b.provider_ref && duffel.capabilities().live) {
    try {
      const c = await duffel.cancelOrder(b.provider_ref);
      notes.push(`أُلغي لدى Duffel (${c.status})${c.refundAmount ? ' · مسترد من المزوّد ' + c.refundAmount + ' ' + (c.refundCurrency || '') : ''}`);
      await repo.addAudit('duffel.cancel', { id, status: c.status, refund: c.refundAmount });
    } catch (e) {
      notes.push('تعذّر الإلغاء لدى المزوّد: ' + e.message);
      /* لا نكمل الاسترداد إن فشل الإلغاء لدى المزوّد */
      throw Object.assign(new Error('لم يُلغَ الحجز لدى شركة الطيران — لم يُنفَّذ أي استرداد: ' + e.message), { statusCode: 502 });
    }
  }

  /* 2) استرداد ما دفعه العميل */
  const payment = await repo.getPaymentByBooking(id);
  if (payment && payment.status === 'succeeded') {
    await pay().refund({ providerRef: payment.provider_ref, amount: payment.amount });
    await repo.updatePayment(payment.id, { status: 'refunded' });
    notes.push('استُرد مبلغ العميل');
  }

  return setStatus(id, 'cancelled', [reason, ...notes].filter(Boolean).join(' · '));
}

/* =========================== مطابقة عمولة الإحالة =========================== */
/**
 * في وضع الإحالة: تقرير المزوّد يصل لاحقًا بمبلغ العمولة الحقيقي.
 * هذه الدالة تُثبّت المبلغ الفعلي ثم تُحوّل الحجز إلى confirmed.
 */
export async function reconcileBooking(id, { commission, note = null } = {}) {
  const b = await repo.getBooking(id);
  if (!b) throw Object.assign(new Error('حجز غير موجود'), { statusCode: 404 });
  if (!(Number(commission) >= 0)) throw Object.assign(new Error('مبلغ عمولة غير صالح'), { statusCode: 400 });

  const partnerE = b.ref && b.ref !== ENV.platformCode
    ? round(Number(commission) * MODEL.partnerCut) : 0;

  const pricing = {
    ...b.pricing,
    supplierCommission: round(Number(commission)),
    partnerEarnings: partnerE,
    platformNet: round(Number(commission) - partnerE - (b.pricing.providerCost || 0)),
    platformNetPct: b.pricing.basePrice ? round(((Number(commission) - partnerE) / b.pricing.basePrice) * 100) : 0,
    reconciled: { commission: round(Number(commission)), at: new Date().toISOString(), note },
  };
  /* تحديث التسعير (jsonb) */
  const { db } = await import('./db/index.js');
  await db().query(`UPDATE bookings SET pricing = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(pricing)]);
  await repo.addAudit('booking.reconciled', { id, commission: Number(commission) });

  /* إشعار العميل بعد تثبيت العمولة */
  repo.getBooking(id).then(b => notify.notifyBooking(b)).catch(() => {});

  const fresh = await repo.getBooking(id);
  if (['referred', 'pending'].includes(fresh.status)) return setStatus(id, 'confirmed', note || 'مطابقة عمولة المزوّد');
  return fresh;
}

/* =========================== معالجة Webhooks =========================== */
export async function handleStripeEvent(event, { verified }) {
  await repo.addWebhook({ provider: 'stripe', type: event.type, verified, payload: event });
  const obj = event.data?.object || {};
  const payment = obj.id ? await repo.getPaymentByProviderRef(obj.id) : null;
  if (!payment) return { handled: false, reason: 'دفعة غير معروفة' };

  if (event.type === 'payment_intent.succeeded' && payment.status !== 'succeeded') {
    await repo.updatePayment(payment.id, { status: 'succeeded' });
    await finalizeBooking(payment.booking_id, {}).catch(() => {});
    return { handled: true, action: 'booking.finalized' };
  }
  if (event.type === 'payment_intent.payment_failed') {
    await repo.updatePayment(payment.id, { status: 'failed', failureReason: obj.last_payment_error?.message || 'فشل الدفع' });
    return { handled: true, action: 'payment.failed' };
  }
  if (event.type === 'charge.refunded') {
    await repo.updatePayment(payment.id, { status: 'refunded' });
    const b = await repo.getBooking(payment.booking_id);
    if (b && b.status === 'confirmed') await setStatus(b.id, 'refunded', 'استرداد عبر Stripe');
    return { handled: true, action: 'refund' };
  }
  return { handled: true, action: 'ignored' };
}

/** Webhook لـChargily: checkout.paid → تثبيت الدفع ثم تأكيد الحجز */
export async function handleChargilyEvent(event, { verified }) {
  await repo.addWebhook({ provider: 'chargily', type: event?.type || event?.event, verified, payload: event });
  const checkoutId = event?.data?.id || event?.id || null;
  const payment = checkoutId ? await repo.getPaymentByProviderRef(checkoutId) : null;
  if (!payment) return { handled: false, reason: 'دفعة غير معروفة' };

  const type = String(event?.type || event?.event || '');
  if (type === 'checkout.paid') {
    if (payment.status === 'succeeded') return { handled: true, action: 'already_paid' };
    await repo.updatePayment(payment.id, { status: 'succeeded' });
    await finalizeBooking(payment.booking_id, {}).catch(() => {});
    return { handled: true, action: 'booking.finalized' };
  }
  if (['checkout.failed', 'checkout.expired', 'checkout.canceled'].includes(type)) {
    await repo.updatePayment(payment.id, { status: 'failed', failureReason: type });
    return { handled: true, action: 'payment.failed' };
  }
  return { handled: true, action: 'ignored' };
}

/**
 * مسار تأكيد احتياطي: صفحة النجاح تستعلم Chargily مباشرة (GET /checkouts/:id).
 * مفيد إن تأخّر الـWebhook أو حجبه جدار ناري — ويبقى idempotent معه.
 */
export async function confirmFromCheckout(checkoutId) {
  const chargily = await import('./payments/chargily.js');
  const c = await chargily.getCheckout(checkoutId);
  if (!c.paid) return { ok: false, status: c.status, reason: 'لم يُدفع بعد' };
  const payment = await repo.getPaymentByProviderRef(checkoutId);
  if (!payment) return { ok: false, reason: 'دفعة غير معروفة' };
  if (payment.status !== 'succeeded') {
    await repo.updatePayment(payment.id, { status: 'succeeded' });
    await finalizeBooking(payment.booking_id, {}).catch(() => {});
  }
  const booking = await repo.getBooking(payment.booking_id);
  return { ok: true, status: booking?.status, bookingId: payment.booking_id };
}

/* =========================== الملخّصات =========================== */
const EARNED = new Set(['confirmed', 'fulfilled']);
const s = (arr, f) => round(arr.reduce((acc, b) => acc + (f(b) || 0), 0));

export async function partnerSummary(code) {
  const p = await repo.getPartner(code);
  if (!p) throw Object.assign(new Error('شريك غير موجود'), { statusCode: 404 });
  const rows = await repo.listBookings({ partnerCode: code, limit: 1000 });
  const earned = rows.filter(b => EARNED.has(b.status));

  return {
    partner: {
      code: p.code, name: p.name, type: p.type, status: p.status,
      email: p.email, country: p.country, createdAt: p.created_at,
      apiKeySet: Boolean(p.api_key),
    },
    bookings: rows.length,
    confirmed: earned.length,
    pending: rows.filter(b => ['pending', 'referred'].includes(b.status)).length,
    cancelled: rows.filter(b => ['cancelled', 'refunded'].includes(b.status)).length,
    gmv: s(earned, b => b.pricing.basePrice),
    fees: s(earned, b => b.pricing.platformFee),
    partnerEarnings: s(earned, b => b.pricing.partnerEarnings),
    partnerUnpaid: s(earned.filter(b => !b.payout_id), b => b.pricing.partnerEarnings),
    partnerUnpaidDzd: toDzd(s(earned.filter(b => !b.payout_id), b => b.pricing.partnerEarnings), ENV.dzdPerUsd),
    payoutAccount: await getDestination('partner', code).catch(() => null),
    fxRate: ENV.dzdPerUsd,
    platformNetFromPartner: s(earned, b => b.pricing.platformNet),
    referralLink: `${(ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port))}/?ref=${p.code}`,
    recent: rows.slice(0, 15).map(b => ({
      id: b.id, vertical: b.vertical, title: b.offer?.title, status: b.status,
      basePrice: b.pricing.basePrice, fee: b.pricing.platformFee,
      partnerEarnings: b.pricing.partnerEarnings, createdAt: b.created_at,
    })),
  };
}

export async function platformSummary() {
  const rows = await repo.listBookings({ limit: 1000 });
  const partners = await repo.listPartners();
  const earned = rows.filter(b => EARNED.has(b.status));

  const byVertical = {};
  for (const [k, v] of Object.entries(VERTICALS)) {
    const sub = earned.filter(b => b.vertical === k);
    byVertical[k] = { name: v.name, bookings: sub.length, gmv: s(sub, b => b.pricing.basePrice), platformNet: s(sub, b => b.pricing.platformNet), fees: s(sub, b => b.pricing.platformFee) };
  }

  const partnerRows = [];
  for (const p of partners) {
    const sub = earned.filter(b => b.ref === p.code);
    partnerRows.push({
      code: p.code, name: p.name, type: p.type, status: p.status,
      bookings: rows.filter(b => b.ref === p.code).length,
      gmv: s(sub, b => b.pricing.basePrice),
      fees: s(sub, b => b.pricing.platformFee),
      partnerEarnings: s(sub, b => b.pricing.partnerEarnings),
      partnerUnpaid: s(sub.filter(b => !b.payout_id), b => b.pricing.partnerEarnings),
      platformNet: s(sub, b => b.pricing.platformNet),
    });
  }

  const gmv = s(earned, b => b.pricing.basePrice);
  const net = s(earned, b => b.pricing.platformNet);
  const payMap = await repo.paymentsForBookings(rows.slice(0, 25).map(b => b.id));

  return {
    model: { feeRate: MODEL.feeRate, partnerCut: MODEL.partnerCut, currency: MODEL.currency },
    mode: ENV.mode,
    payments: paymentInfo(),
    bookings: rows.length,
    confirmed: earned.length,
    gmv,
    customerFees: s(earned, b => b.pricing.platformFee),
    supplierCommission: s(earned, b => b.pricing.supplierCommission),
    providerCost: s(earned, b => b.pricing.providerCost),
    platformNet: net,
    partnersPaid: s(earned.filter(b => b.payout_id), b => b.pricing.partnerEarnings),
    partnersUnpaid: s(earned.filter(b => !b.payout_id), b => b.pricing.partnerEarnings),
    effectiveMarginPct: gmv ? round((net / gmv) * 100) : 0,
    byVertical,
    partners: partnerRows,
    adapters: { duffel: duffel.capabilities(), viator: viator.capabilities() },
    pendingPartners: partners.filter(p => p.status === 'pending').map(p => ({ code: p.code, name: p.name, type: p.type, email: p.email, createdAt: p.created_at })),
    outbox: await notify.outboxSummary(15),
    payouts: (await repo.listPayouts(20)).map(p => ({
      id: p.id, ownerType: p.owner_type, partnerName: p.partner_name,
      amount: Number(p.amount), amountDzd: p.amount_dzd == null ? null : Number(p.amount_dzd),
      destination: p.destination, reference: p.reference, method: p.method,
      bookings: (p.items || []).length, createdAt: p.created_at, status: p.status,
    })),
    recent: rows.slice(0, 25).map(b => ({
      id: b.id, ref: b.ref, partnerName: partners.find(p => p.code === b.ref)?.name || b.ref,
      vertical: VERTICALS[b.vertical]?.name || b.vertical, title: b.offer?.title,
      basePrice: b.pricing.basePrice, fee: b.pricing.platformFee, supplier: b.pricing.supplierCommission,
      partnerEarnings: b.pricing.partnerEarnings, platformNet: b.pricing.platformNet,
      netPct: b.pricing.platformNetPct, status: b.status, createdAt: b.created_at, payoutId: b.payout_id,
      payment: payMap[b.id] ? { status: payMap[b.id].status, amount: Number(payMap[b.id].amount), provider: payMap[b.id].provider, method: payMap[b.id].method } : null,
    })),
  };
}

/* ═══════════════════ حسابات التحصيل (CCP) ═══════════════════ */

/**
 * يسجّل حساب التحصيل لصاحب الحساب (المنصة أو شريك).
 * الشريك يعبّئ: رقم CCP + المفتاح + الاسم كما في الدفتر البريدي + مكتب البريد.
 */
export async function setPayoutAccount({ ownerType = 'partner', ownerCode, method = 'ccp', holderName, ccpNumber, ccpKey, ccpAgency, bankRib, foreignWallet, verified = false }) {
  if (!ownerCode) throw Object.assign(new Error('كود صاحب الحساب مطلوب'), { statusCode: 400 });
  if (ownerType === 'partner' && !(await repo.getPartner(ownerCode))) {
    throw Object.assign(new Error('شريك غير موجود'), { statusCode: 404 });
  }

  let ccp = {};
  if (method === 'ccp') {
    ccp = validateCcp({ number: ccpNumber, key: ccpKey, holder: holderName, agency: ccpAgency });
  } else if (!holderName) {
    throw Object.assign(new Error('اسم صاحب الحساب مطلوب'), { statusCode: 400 });
  }

  const acc = await repo.upsertPayoutAccount({
    ownerType, ownerCode, method,
    holderName: ccp.holder || String(holderName).trim(),
    ccpNumber: ccp.number, ccpKey: ccp.key, ccpAgency: ccp.agency,
    bankRib, foreignWallet, currency: 'DZD', verified,
  });
  await repo.addAudit('payout_account.saved', { ownerType, ownerCode, method, masked: maskCcp(acc.ccp_number, acc.ccp_key) });
  return publicAccount(acc);
}

/** وجهة التحويل لصاحب حساب: من القاعدة، وإلا من إعدادات المنصة (ENV) */
export async function getDestination(ownerType, ownerCode) {
  const acc = await repo.getPayoutAccount(ownerType, ownerCode);
  if (acc) return { ...publicAccount(acc), source: 'account' };

  if (ownerType === 'platform' && ENV.ccpNumber) {
    const ccp = validateCcp({ number: ENV.ccpNumber, key: ENV.ccpKey, holder: ENV.ccpHolder || 'MARIA', agency: ENV.ccpAgency });
    return {
      ownerType: 'platform', ownerCode, method: 'ccp', holderName: ccp.holder,
      masked: maskCcp(ccp.number, ccp.key), agency: ccp.agency, currency: 'DZD',
      verified: true, source: 'env',
    };
  }
  return null;
}

/** كشف عمولة المنصة غير المحوَّلة بعد (بالدولار والدينار) */
export async function platformPayoutReport() {
  const rows = await repo.listBookings({ limit: 2000 });
  const earned = rows.filter(b => EARNED.has(b.status));
  const availableRows = earned.filter(b => !b.platform_payout_id);
  const amount = round(availableRows.reduce((a, b) => a + (b.pricing.platformNet || 0), 0));
  const meta = paymentInfo();
  const dest = await getDestination('platform', ENV.platformCode);
  return {
    currency: MODEL.currency,
    rate: ENV.dzdPerUsd,
    totalNet: round(earned.reduce((a, b) => a + (b.pricing.platformNet || 0), 0)),
    available: amount,
    availableDzd: toDzd(amount, ENV.dzdPerUsd),
    bookings: availableRows.length,
    destination: dest,
    channel: ENV.payoutChannel,
    blocked: dest ? null : 'لم يُسجَّل الحساب البريدي: أضف MARIA_CCP_NUMBER و MARIA_CCP_KEY و MARIA_CCP_HOLDER',
    payments: meta,
  };
}

/* =========================== التحويلات =========================== */

/** ينشئ تحويلًا واحدًا (CCP) لصاحب حساب مع مبلغ الدينار ومرجع الحوالة */
async function createPayoutFor({ ownerType, ownerCode, name, due, amount }) {
  const dest = await getDestination(ownerType, ownerCode);
  const payout = await repo.addPayout({
    id: 'po_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    partnerCode: ownerCode, partnerName: name, ownerType,
    amount, currency: MODEL.currency,
    items: due.map(b => ({ id: b.id, fee: b.pricing.platformFee, share: ownerType === 'partner' ? b.pricing.partnerEarnings : b.pricing.platformNet })),
    status: 'pending',                                    // ينتظر تنفيذ الحوالة البريدية
    method: dest?.method || ENV.payoutChannel,
    holderName: dest?.holderName || name,
    destination: dest ? `${dest.masked} — ${dest.holderName}` : 'بلا حساب مسجَّل',
    fxRate: ENV.dzdPerUsd,
    amountDzd: toDzd(amount, ENV.dzdPerUsd),
  });
  return payout;
}

export async function runPayouts({ partnerCode = null, force = true } = {}) {
  const partners = partnerCode ? [await repo.getPartner(partnerCode)].filter(Boolean) : await repo.listPartners();
  const cutoff = Date.now() - MODEL.payoutCycleDays * 86400000;
  const created = [];

  for (const p of partners) {
    const due = (await repo.listBookings({ partnerCode: p.code, limit: 2000 })).filter(b =>
      EARNED.has(b.status) && !b.payout_id && (force || new Date(b.created_at).getTime() <= cutoff)
    );
    if (!due.length) continue;
    const amount = round(due.reduce((acc, b) => acc + b.pricing.partnerEarnings, 0));
    if (amount <= 0) continue;

    const payout = await createPayoutFor({ ownerType: 'partner', ownerCode: p.code, name: p.name, due, amount });
    for (const b of due) await repo.updateBooking(b.id, { payout_id: payout.id });
    await repo.addLedger({ ref: p.code, type: 'payout', status: 'pending', amount });
    created.push(payout);
  }
  await repo.addAudit('payouts.run', { count: created.length, channel: ENV.payoutChannel });
  return created;
}

/**
 * تحويل عمولة المنصة إلى حسابك البريدي (CCP).
 * يجمّع كل الأرباح المؤكَّدة غير المحوَّلة في تحويل واحد.
 */
export async function runPlatformPayout({ idempotent = true } = {}) {
  const rows = await repo.listBookings({ limit: 2000 });
  const due = rows.filter(b => EARNED.has(b.status) && !b.platform_payout_id && (b.pricing.platformNet || 0) > 0);
  if (!due.length) return { payout: null, message: 'لا عمولات جديدة قابلة للتحويل' };
  if (idempotent) {
    const open = (await repo.listPayouts(50, 'platform')).find(p => p.status === 'pending');
    if (open) return { payout: open, message: 'يوجد تحويل قيد التنفيذ — أكّده أو ألغِه أولًا' };
  }
  const amount = round(due.reduce((a, b) => a + b.pricing.platformNet, 0));
  if (amount <= 0) return { payout: null, message: 'لا رصيد موجب' };

  const payout = await createPayoutFor({ ownerType: 'platform', ownerCode: ENV.platformCode, name: 'ماريا — المنصة', due, amount });
  for (const b of due) await repo.updateBooking(b.id, { platformPayoutId: payout.id });
  await repo.addLedger({ ref: ENV.platformCode, type: 'payout', status: 'pending', amount });
  await repo.addAudit('payout.platform', { id: payout.id, amount, amountDzd: payout.amount_dzd });
  return {
    payout,
    message: 'تحويل جاهز — نفّذ الحوالة البريدية إلى الحساب المذكور ثم سجّل رقم الحوالة',
  };
}

/** بعد تنفيذ الحوالة في مكتب البريد: تسجيل الوصل ⇒ التحويل يصبح مُنفَّذًا */
export async function confirmPayout(id, { reference, executedAt = null } = {}) {
  const p = await repo.getPayout(id);
  if (!p) throw Object.assign(new Error('تحويل غير موجود'), { statusCode: 404 });
  if (!reference) throw Object.assign(new Error('رقم وصل الحوالة البريدية مطلوب'), { statusCode: 400 });
  if (p.status === 'sent') return p;

  const out = await repo.updatePayout(id, { status: 'sent', reference: String(reference).trim(), executedAt: executedAt || new Date().toISOString() });
  for (const it of (p.items || [])) {
    await repo.addLedger({ bookingId: it.id, ref: p.partner_code, type: 'settle', status: 'paid', amount: Number(it.share), reason: 'حوالة بريدية ' + reference });
  }
  await repo.addAudit('payout.sent', { id, reference, amountDzd: Number(p.amount_dzd) });

  /* إشعار الشريك بتحويل مستحقاته */
  if (p.owner_type === 'partner') notify.notifyPayout(out, p.partner_name).catch(() => {});
  return out;
}

/** كشف التحويلات (للتصدير أو الطباعة) */
export async function payoutStatement({ ownerType = null, limit = 100 } = {}) {
  const rows = await repo.listPayouts(limit, ownerType);
  return rows.map(p => ({
    id: p.id, code: p.partner_code, ownerType: p.owner_type,
    owner: p.owner_type === 'platform' ? 'المنصة' : p.partner_name || p.partner_code,
    amountUsd: Number(p.amount), rate: p.fx_rate == null ? null : Number(p.fx_rate),
    amountDzd: p.amount_dzd == null ? null : Number(p.amount_dzd),
    destination: p.destination, holder: p.holder_name, method: p.method,
    status: p.status, reference: p.reference, executedAt: p.executed_at, createdAt: p.created_at,
    bookings: (p.items || []).length,
  }));
}

/* =========================== تسجيل الشركاء ذاتيًا =========================== */
export async function applyPartner({ name, type = 'agency', email, phone, country, payoutMethod, autoApprove = false }) {
  if (!name || !email) throw Object.assign(new Error('الاسم والبريد مطلوبان'), { statusCode: 400 });

  const ascii = String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  const base = ascii
    ? ascii.split(/\s+/).slice(0, 2).join('-').slice(0, 12)
    : 'PARTNER-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  let code = base;
  let n = 0;
  while (await repo.getPartner(code)) { n++; code = base.slice(0, 10) + '-' + n; }

  const apiKey = 'mrn_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const partner = await repo.createPartner({
    code, name, type, email, phone, country,
    status: autoApprove ? 'active' : 'pending',
    payoutMethod: payoutMethod || {},
    apiKey,
  });
  await repo.addAudit('partner.applied', { code, email, autoApprove });

  return {
    partner: { code: partner.code, name: partner.name, status: partner.status, type: partner.type },
    apiKey,                                     // تُعرض مرة واحدة
    referralLink: `${(ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port))}/?ref=${partner.code}`,
    message: partner.status === 'active'
      ? 'تم تفعيل حسابك — يمكنك البدء بالبيع الآن'
      : 'طلبك قيد المراجعة — ستُفعَّل خلال 24 ساعة',
  };
}

export async function approvePartner(code) {
  const p = await repo.setPartnerStatus(code, 'active');
  if (!p) throw Object.assign(new Error('شريك غير موجود'), { statusCode: 404 });
  await repo.addAudit('partner.approved', { code });
  return p;
}

export { round };
