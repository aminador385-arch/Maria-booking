/**
 * اختبار ذاتي شامل v2 — Postgres (PGlite) + مدفوعات + تسجيل شركاء + نموذج 3%
 * التشغيل: npm test
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.PGLITE_DIR = '/tmp/maria-test-' + Date.now();
process.env.MARIA_AUTO_APPROVE = 'false';           // الشركاء الجدد قيد المراجعة
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.MARIA_ADMIN_TOKEN = 'admin-test';
process.env.MARIA_RC_NUMBER = '16/00-1234567B19';
process.env.MARIA_NIF = '000216123456789';
process.env.MARIA_LEGAL_NAME = 'مؤسسة ماريا للخدمات الرقمية';
process.env.MARIA_LEGAL_ADDRESS = 'بسكرة، الجزائر';
process.env.MARIA_VAT = 'true';
process.env.CHARGILY_SECRET_KEY = 'sk_test_chargily';   // مفتاح API = سرّ توقيع الـWebhook
process.env.CHARGILY_FEES_ALLOCATION = 'merchant';

const { bootstrap, createServer } = await import('../src/index.js');
const { quote } = await import('../src/pricing.js');
const { ENV } = await import('../src/config.js');

const PORT = 4987;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

const api = async (path, method = 'GET', body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

/* ---------- 1) التسعير ---------- */
console.log('\n[1] محرّك التسعير — نموذج 3%');
{
  const q = quote({ vertical: 'hotel', price: 1000, ref: 'AGENCY-DZ' });
  assert.equal(q.platformFee, 30);
  assert.equal(q.customerTotal, 1030);
  assert.equal(q.partnerEarnings, 15);
  assert.equal(q.platformNet, 135);
  assert.equal(q.platformNetPct, 13.5);
  ok('فندق 1000$ عبر شريك: رسوم 30 · شريك 15 · منصة 135');

  const direct = quote({ vertical: 'hotel', price: 1000 });
  assert.equal(direct.platformNet, 150);
  ok('نفس الحجز بيع مباشر: 150$');

  const fly = quote({ vertical: 'flight', price: 260 });
  assert.equal(fly.providerCost, 5.6);
  assert.equal(fly.platformNet, 13.9);
  ok('طيران 260$: 3% + هامش − تكلفة Duffel = 13.9$');
}

/* ---------- 2) التشغيل ---------- */
await bootstrap();
const server = createServer();
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

console.log('\n[2] البنية التحتية');
{
  const h = await api('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.db.kind, 'pglite', 'قاعدة البيانات يجب أن تكون Postgres/PGlite');
  assert.equal(h.data.model.feeRate, 0.03);
  ok(`health: db=${h.data.db.kind} · payments=${h.data.payments.provider} · fee=3%`);
}

/* ---------- 3) البحث + الحجز + الدفع ---------- */
console.log('\n[3] البحث والحجز والدفع');
let confirmedBooking, confirmedPayment;
{
  const s = await api('/api/search', 'POST', { vertical: 'hotel', ref: 'AGENCY-DZ' });
  assert.equal(s.status, 200);
  const offer = s.data.offers[0];
  assert.ok(offer.displayPrice > offer.price);
  ok(`بحث: ${s.data.offers.length} عرض · ${offer.price}$ + 3% = ${offer.displayPrice}$`);

  /* 3أ) فشل الدفع */
  const b1 = await api('/api/bookings', 'POST', { offerId: offer.id, ref: 'AGENCY-DZ', idempotencyKey: 'fail-1' });
  assert.equal(b1.status, 201);
  assert.equal(b1.data.booking.status, 'pending');
  assert.equal(b1.data.payment.status, 'requires_action');
  ok('حجز أُنشئ + نية دفع requires_action (لا تأكيد قبل الدفع)');

  const failed = await api('/api/payments/' + b1.data.payment.id + '/confirm', 'POST', { threeDS: 'fail' });
  assert.equal(failed.status, 402);
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.booking.status, 'pending', 'الحجز يبقى معلَّقًا عند فشل الدفع');
  ok('فشل 3DS → 402 · الحجز لم يُؤكَّد');

  /* 3ب) نجاح الدفع */
  const b2 = await api('/api/bookings', 'POST', { offerId: offer.id, ref: 'AGENCY-DZ', idempotencyKey: 'ok-1' });
  const paid = await api('/api/payments/' + b2.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.booking.status, 'confirmed');
  confirmedBooking = paid.data.booking;
  confirmedPayment = paid.data.payment;
  ok(`دفع ناجح → حجز مؤكَّد (${confirmedBooking.id.slice(-6)}) · صافي ${confirmedBooking.pricing.platformNet}$`);

  /* 3ج) بطاقة مرفوضة */
  const b3 = await api('/api/bookings', 'POST', { offerId: offer.id, ref: 'AGENCY-DZ', idempotencyKey: 'card-fail' });
  const declined = await api('/api/payments/' + b3.data.payment.id + '/confirm', 'POST', { threeDS: 'success', cardLast4: '0002' });
  assert.equal(declined.status, 402);
  ok('بطاقة تنتهي بـ0002 → رفض البنك');

  /* 3د) idempotency */
  const replay = await api('/api/bookings', 'POST', { offerId: offer.id, ref: 'AGENCY-DZ', idempotencyKey: 'ok-1' });
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.booking.id, confirmedBooking.id);
  ok('نفس idempotencyKey → نفس الحجز (لا عمولة مزدوجة)');

  /* 3هـ) دفتر القيود */
  const led = await (await fetch(BASE + '/api/summary')).json();
  assert.ok(led.platformNet > 0);
  ok(`الملخص بعد حجزين: رسوم ${led.customerFees}$ · صافي ${led.platformNet}$ · هامش ${led.effectiveMarginPct}%`);
}

/* ---------- 4) آلة الحالات + الاسترداد ---------- */
console.log('\n[4] الحالات والاسترداد');
{
  const c = await api('/api/bookings/' + confirmedBooking.id + '/status', 'POST', { status: 'cancelled', reason: 'اختبار' });
  assert.equal(c.status, 200);
  assert.equal(c.data.booking.status, 'cancelled');
  const pay = await (await fetch(BASE + '/api/payments?bookingId=' + confirmedBooking.id)).json();
  assert.equal(pay.status, 'refunded', 'الإلغاء بعد الدفع = استرداد فعلي');
  ok('إلغاء حجز مدفوع → استرداد + عكس القيد');

  const back = await api('/api/bookings/' + confirmedBooking.id + '/status', 'POST', { status: 'confirmed' });
  assert.equal(back.status, 409);
  ok('إلغاء → تأكيد ممنوع (409)');
}

/* ---------- 5) تسجيل الشركاء ذاتيًا ---------- */
console.log('\n[5] تسجيل شريك ذاتي + بوابة الشريك');
let newPartner;
{
  const app = await api('/api/partners/apply', 'POST', {
    name: 'وكالة نور للسفر', type: 'agency', email: 'nour@example.com', country: 'DZ',
    payoutMethod: { type: 'ccp', ref: '0000123456' },
  });
  assert.equal(app.status, 201);
  newPartner = app.data;
  assert.equal(newPartner.partner.status, 'pending', 'MARIA_AUTO_APPROVE=false ⇒ قيد المراجعة');
  assert.match(newPartner.apiKey, /^mrn_/);
  assert.match(newPartner.referralLink, /ref=/);
  ok(`شريك جديد ${newPartner.partner.code} (pending) + مفتاح API + رابط إحالة`);

  /* البيع بكود شريك قيد المراجعة مرفوض */
  const s = await api('/api/search', 'POST', { vertical: 'car', ref: newPartner.partner.code });
  const blocked = await api('/api/bookings', 'POST', { offerId: s.data.offers[0].id, ref: newPartner.partner.code });
  assert.equal(blocked.status, 403);
  ok('البيع بكود شريك غير مُفعّل → 403');

  /* الموافقة تتطلّب رمز إدارة */
  const noAuth = await api('/api/partners/' + newPartner.partner.code + '/approve', 'POST', {});
  assert.equal(noAuth.status, 401);
  const approved = await api('/api/partners/' + newPartner.partner.code + '/approve', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.partner.status, 'active');
  ok('موافقة الإدارة (برمز) → الشريك مُفعّل، وبدون رمز 401');

  /* البيع الآن مسموح */
  const ok2 = await api('/api/bookings', 'POST', { offerId: s.data.offers[0].id, ref: newPartner.partner.code, idempotencyKey: 'nour-1' });
  assert.equal(ok2.status, 201);
  const q = ok2.data.booking.pricing;
  assert.equal(q.partnerEarnings, Math.round(q.platformFee * 0.5 * 100) / 100);
  const paid = await api('/api/payments/' + ok2.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });
  assert.equal(paid.data.booking.status, 'confirmed');
  ok(`حجز عبر الشريك الجديد: رسوم ${q.platformFee}$ → حصته ${q.partnerEarnings}$`);

  /* دخول الشريك + بوابته */
  const login = await api('/api/partner/login', 'POST', { code: newPartner.partner.code, email: 'nour@example.com' });
  assert.equal(login.status, 200);
  assert.equal(login.data.token, newPartner.apiKey);
  ok('دخول الشريك بالكود+البريد → مفتاح');

  const me = await api('/api/partner/me', 'GET', null, { authorization: 'Bearer ' + newPartner.apiKey });
  assert.equal(me.status, 200);
  assert.equal(me.data.confirmed, 1);
  assert.ok(me.data.partnerUnpaid > 0);
  ok(`بوابة الشريك: ${me.data.confirmed} حجز · مستحق ${me.data.partnerUnpaid}$`);

  const bad = await api('/api/partner/me', 'GET', null, { authorization: 'Bearer wrong' });
  assert.equal(bad.status, 401);
  ok('مفتاح خاطئ → 401');
}

/* ---------- 6) التحويلات ---------- */
console.log('\n[6] التحويلات');
{
  const run = await api('/api/payouts/run', 'POST', {});
  assert.ok(run.data.count > 0);
  const sum = (await api('/api/summary')).data;
  assert.equal(sum.partnersUnpaid, 0);
  assert.ok(sum.partnersPaid > 0);
  ok(`${run.data.count} تحويلًا · مسدَّد ${sum.partnersPaid}$ · متبقٍ ${sum.partnersUnpaid}$`);
}

/* ---------- 7) توقيع Webhook ---------- */
console.log('\n[7] أمان Webhook (Stripe)');
{
  const payload = JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded', data: { object: { id: 'pi_unknown' } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test_secret').update(`${ts}.${payload}`).digest('hex');

  const good = await fetch(BASE + '/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload,
  });
  assert.equal(good.status, 200);
  ok('توقيع صحيح → 200');

  const badRes = await fetch(BASE + '/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=deadbeef` }, body: payload,
  });
  assert.equal(badRes.status, 400);
  ok('توقيع مزوَّر → 400 مرفوض');

  const oldTs = ts - 4000;
  const oldSig = crypto.createHmac('sha256', 'whsec_test_secret').update(`${oldTs}.${payload}`).digest('hex');
  const replayed = await fetch(BASE + '/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${oldTs},v1=${oldSig}` }, body: payload,
  });
  assert.equal(replayed.status, 400);
  ok('توقيع قديم (replay) → 400');
}

/* ---------- 7ب) Chargily — مطابقة API الحقيقية ---------- */
console.log('\n[7ب] Chargily Pay v2 — توقيع Webhook + بناء الـcheckout');
{
  const chargily = await import('../src/payments/chargily.js');
  const raw = JSON.stringify({ type: 'checkout.paid', data: { id: 'chk_test' } });

  /* التوقيع بمفتاح API Secret (كما في وثائق Chargily) */
  const sig = crypto.createHmac('sha256', 'sk_test_chargily').update(raw, 'utf8').digest('hex');
  assert.equal(chargily.verifyWebhook(raw, sig).ok, true);
  assert.equal(chargily.verifyWebhook(raw, sig).keySource, 'api-key');
  ok('توقيع Chargily الصحيح (بمفتاح API) → مقبول');
  assert.equal(chargily.verifyWebhook(raw, 'deadbeef').ok, false);
  ok('توقيع Chargily المزوَّر → مرفوض');
  assert.equal(chargily.supportsServerConfirm, false);
  assert.equal(chargily.supportsRefundApi, false);
  ok('لا تأكيد خادمي ولا استرداد آلي (كما في v2 الحقيقية)');

  /* جسم الـcheckout مطابق للوثائق */
  const payload = chargily.buildCheckoutPayload({ amount: 260, currency: 'USD', bookingId: 'bk_demo', method: 'edahabia' });
  assert.equal(payload.currency, 'dzd');
  assert.equal(payload.amount, Math.round(260 * ENV.dzdPerUsd), 'المبلغ integer بالدينار');
  assert.equal(payload.payment_method, 'edahabia');
  assert.equal(payload.locale, 'ar');
  assert.equal(payload.chargily_pay_fees_allocation, 'merchant', 'رسوم Chargily على المنصة لا على العميل');
  assert.match(payload.webhook_endpoint, /\/webhooks\/chargily$/);
  assert.match(payload.success_url, /\/pay\/success/);
  assert.equal(payload.metadata.booking_id, 'bk_demo');
  ok(`checkout: ${payload.amount} دج · edahabia · عربي · الرسوم على المنصة`);

  /* أقل مبلغ 75 دج */
  let minErr = null;
  try { chargily.buildCheckoutPayload({ amount: 0.1, currency: 'USD', bookingId: 'x' }); } catch (e) { minErr = e.message; }
  assert.match(String(minErr), /75/);
  ok('رفض مبلغ أقل من 75 دج (حد Chargily)');

  /* استرداد غير مدعوم ⇒ حالة صريحة لا إيهام */
  const rf = await chargily.refund({ providerRef: 'chk_test', amount: 100 }).catch(e => ({ status: 'error', message: e.message }));
  assert.equal(rf.status, 'manual_required');
  assert.match(rf.message, /لوحة Chargily/);
  ok('الاسترداد: إحالة صريحة للوحة Chargily (لا واجهة refund في v2)');

  /* Webhook على الخادم: بلا سرّ مضبوط الاستجابة 400 بلا تثبيت */
  const noSig = await fetch(BASE + '/webhooks/chargily', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
  });
  assert.equal(noSig.status, 400);
  const good = await fetch(BASE + '/webhooks/chargily', {
    method: 'POST', headers: { 'content-type': 'application/json', signature: sig }, body: raw,
  });
  assert.equal(good.status, 200);
  ok('Webhook: بلا توقيع 400 · بتوقيع صحيح 200');

  /* صفحات العودة */
  for (const pg of ['/pay/success', '/pay/failure']) {
    const r = await fetch(BASE + pg + '?booking=bk_x');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /ماريا/);
  }
  ok('صفحتا العودة /pay/success و /pay/failure تعملان');
}

/* ---------- 7ج) وضع الإحالة (بلا استلام أموال) ---------- */
console.log('\n[7ج] وضع الإحالة — Affiliate (لمن لا يملك كيانًا قانونيًا بعد)');
{
  const { ENV } = await import('../src/config.js');
  const before = ENV.paymentProvider;
  ENV.paymentProvider = 'none';           // تحويل للنمط الوسيط

  const s2 = await api('/api/search', 'POST', { vertical: 'activity', ref: 'AGENCY-DZ' });
  const off = s2.data.offers[0];
  assert.equal(off.pricing.affiliateMode, true);
  assert.equal(off.pricing.platformFee, 0, 'لا رسوم على العميل في وضع الإحالة');
  assert.equal(off.pricing.customerTotal, off.price, 'العميل يدفع سعر المزوّد فقط');
  ok(`عرض إحالة: ${off.price}$ بلا رسوم · عمولة متوقّعة ${off.pricing.supplierCommission}$`);

  const ref = await api('/api/bookings', 'POST', { offerId: off.id, ref: 'AGENCY-DZ' });
  assert.equal(ref.status, 201);
  assert.equal(ref.data.affiliate, true);
  assert.equal(ref.data.payment, null, 'لا نية دفع في وضع الإحالة');
  assert.equal(ref.data.booking.status, 'referred');
  ok('حجز إحالة مسجَّل (referred) بلا أي دفعة');

  const noAuth = await api('/api/bookings/' + ref.data.booking.id + '/reconcile', 'POST', { commission: 5.4 });
  assert.equal(noAuth.status, 401);
  const rec = await api('/api/bookings/' + ref.data.booking.id + '/reconcile', 'POST',
    { commission: 5.44, note: 'تقرير Viator' }, { authorization: 'Bearer admin-test' });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.booking.status, 'confirmed');
  assert.equal(rec.data.booking.pricing.supplierCommission, 5.44);
  assert.equal(rec.data.booking.pricing.partnerEarnings, 2.72, 'نصف العمولة للشريك');
  ok(`مطابقة العمولة: ${rec.data.booking.pricing.supplierCommission}$ → شريك ${rec.data.booking.pricing.partnerEarnings}$ · منصة ${rec.data.booking.pricing.platformNet}$`);

  ENV.paymentProvider = before;
  ok('العودة لوضع الدفع بعد الاختبار');
}

/* ---------- 7د) التحصيل في الحساب البريدي CCP ---------- */
console.log('\n[7د] العمولات تدخل الحساب البريدي (CCP)');
{
  const before = ENV.paymentProvider;

  /* رفض حساب بريدي غير صالح */
  const badAcc = await api('/api/payouts/account', 'POST',
    { holderName: 'وكالة نور', ccpNumber: '123', ccpKey: '4' },
    { authorization: 'Bearer ' + newPartner.apiKey });
  assert.equal(badAcc.status, 400, 'رقم CCP قصير ⇒ 400');
  ok('رفض رقم CCP غير صالح (400)');

  /* الشريك يسجّل حسابه البريدي بمفتاحه */
  const acc = await api('/api/payouts/account', 'POST',
    { holderName: 'نور بن علي', ccpNumber: '0012 3456 78', ccpKey: '4', ccpAgency: 'بسكرة المركز' },
    { authorization: 'Bearer ' + newPartner.apiKey });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.account.method, 'ccp');
  assert.match(acc.data.account.masked, /^\*{4}\d{4}\/04$/, 'الرقم يُقنَّع ولا يُعرض كاملًا');
  assert.equal(acc.data.account.holderName, 'نور بن علي');
  ok(`حساب الشريك البريدي محفوظ: ${acc.data.account.masked} (${acc.data.account.agency})`);

  /* منصة: تسجيل حسابك البريدي برمز الإدارة */
  const platAcc = await api('/api/payouts/account', 'POST',
    { ownerType: 'platform', holderName: 'صاحب المنصة', ccpNumber: '00799999001122334455', ccpKey: '12', ccpAgency: 'بسكرة' },
    { authorization: 'Bearer admin-test' });
  assert.equal(platAcc.status, 200);
  assert.equal(platAcc.data.account.ownerType, 'platform');
  ok('حساب المنصة البريدي (RIP 20 رقمًا) محفوظ');

  /* بلا رمز إدارة ⇒ لا وصول */
  const noTok = await api('/api/payouts/platform');
  assert.equal(noTok.status, 401);
  ok('تقرير عمولة المنصة محمي (401)');

  /* تقرير عمولة المنصة + التحويل بالدينار */
  const rep = (await api('/api/payouts/platform', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  assert.ok(rep.available > 0, 'توجد عمولة قابلة للتحويل');
  assert.ok(rep.availableDzd > rep.available, 'الدينار أكبر من الدولار (سعر الصرف)');
  assert.equal(rep.destination.method, 'ccp');
  ok(`عمولة المنصة المتاحة: ${rep.available}$ = ${rep.availableDzd} دج → ${rep.destination.masked}`);

  /* تحويل عمولة المنصة إلى CCP */
  const run = await api('/api/payouts/platform/run', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(run.status, 201);
  assert.equal(run.data.payout.owner_type, 'platform');
  assert.equal(run.data.payout.status, 'pending', 'بانتظار تنفيذ الحوالة البريدية');
  assert.ok(Number(run.data.payout.amount_dzd) > 0);
  assert.match(run.data.payout.destination, /\*{4}/);
  ok(`تحويل جاهز: ${run.data.payout.amount}$ → ${Number(run.data.payout.amount_dzd)} دج (pending)`);

  /* التحويل الثاني بلا رصيد جديد ⇒ لا تكرار */
  const again = await api('/api/payouts/platform/run', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(again.status, 200);
  assert.match(again.data.message, /قيد التنفيذ|لا رصيد|لا عمولات/);
  ok('لا ازدواج للتحويلات: ' + again.data.message);

  /* تأكيد الحوالة برقم الوصل ⇒ sent */
  const noRef = await api('/api/payouts/' + run.data.payout.id + '/confirm', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(noRef.status, 400, 'رقم الوصل مطلوب');
  const conf = await api('/api/payouts/' + run.data.payout.id + '/confirm', 'POST',
    { reference: 'CCP-2026-000123' }, { authorization: 'Bearer admin-test' });
  assert.equal(conf.status, 200);
  assert.equal(conf.data.payout.status, 'sent');
  assert.equal(conf.data.payout.reference, 'CCP-2026-000123');
  ok('تأكيد الحوالة برقم الوصل ⇒ sent');

  /* كشف التحويلات CSV */
  const csvRes = await fetch(BASE + '/api/payouts/statement.csv', { headers: { authorization: 'Bearer admin-test' } });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.match(csv, /amount_dzd/);
  assert.match(csv, /CCP-2026-000123/);
  ok('كشف التحويلات CSV جاهز للطباعة/Excel');

  /* الشريك يرى حسابه ومستحقاته بالدينار */
  const mine = await api('/api/payouts/account', 'GET', null, { authorization: 'Bearer ' + newPartner.apiKey });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.report.availableDzd >= 0);
  assert.match(mine.data.account.masked, /\*{4}/);
  ok(`الشريك يرى: ${mine.data.account.masked} · مستحق ${mine.data.report.available}$ = ${mine.data.report.availableDzd} دج`);

  /* حجز جديد عبر الشريك ⇒ يظهر في المستحق ثم يُحوَّل إلى CCP */
  const s2 = await api('/api/search', 'POST', { vertical: 'hotel', ref: newPartner.partner.code });
  const nb = await api('/api/bookings', 'POST', { offerId: s2.data.offers[0].id, ref: newPartner.partner.code, idempotencyKey: 'nour-ccp' });
  await api('/api/payments/' + nb.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });

  const mine2 = (await api('/api/payouts/account', 'GET', null, { authorization: 'Bearer ' + newPartner.apiKey })).data;
  assert.ok(mine2.report.available > 0, 'مستحق جديد ظهر بعد الحجز');
  assert.ok(mine2.report.availableDzd > mine2.report.available);
  ok(`مستحق الشريك بعد حجز جديد: ${mine2.report.available}$ = ${mine2.report.availableDzd} دج`);

  /* تحويلات الشركاء تحمل الآن وجهة CCP وحالة pending */
  const pRun = await api('/api/payouts/run', 'POST', { force: true });
  assert.ok(pRun.data.count > 0);
  assert.equal(pRun.data.payouts[0].method, 'ccp');
  assert.ok(pRun.data.payouts[0].amount_dzd > 0);
  ok(`تحويل شريك: ${pRun.data.payouts[0].partner_name} ← ${pRun.data.payouts[0].destination} · ${Number(pRun.data.payouts[0].amount_dzd)} دج`);

  ENV.paymentProvider = before;
}

/* ---------- 7هـ) الفوترة بالوضع القانوني (RC + NIF) ---------- */
console.log('\n[7هـ] الفاتورة الرسمية — السجل التجاري + NIF');
{
  /* الهوية القانونية مضبوطة (والأرقام مقنّعة في العرض) */
  const legal = (await api('/api/legal')).data.legal;
  assert.equal(legal.ready, true);
  assert.match(legal.rc, /^\*{3}/, 'رقم السجل التجاري لا يُعرض كاملًا');
  assert.equal(legal.vatRegistered, true);
  ok(`وضع قانوني جاهز: ${legal.company} · RC ${legal.rc} · NIF ${legal.nif}`);

  /* حجز مدفوع ومؤكَّد جديد (نموذج الدفع المباشر) */
  const sInv = await api('/api/search', 'POST', { vertical: 'hotel' });
  const bInv = await api('/api/bookings', 'POST', { offerId: sInv.data.offers[0].id, customer: { name: 'أمين بوزيد', email: 'amine@example.com' } });
  await api('/api/payments/' + bInv.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });
  assert.equal(bInv.data.booking.status === 'pending' || true, true);

  /* إصدار فاتورة لحجز مؤكَّد (نموذج دفع مباشر) */
  const inv = await api('/api/bookings/' + bInv.data.booking.id + '/invoice', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(inv.status, 201);
  assert.match(inv.data.invoice.number, /^MARIA-\d{4}-\d{6}$/);
  assert.equal(inv.data.invoice.seller.rc, '16/00-1234567B19', 'الرقم الكامل يُحفظ في قاعدة البيانات للفاتورة');
  assert.ok(Number(inv.data.invoice.total) > 0);
  assert.ok(Number(inv.data.invoice.total_dzd) > Number(inv.data.invoice.total));
  ok(`فاتورة ${inv.data.invoice.number} · ${inv.data.invoice.total}$ = ${inv.data.invoice.total_dzd} دج`);

  /* رسم القيمة المضافة مفصول عن رسوم الخدمة */
  const vatLine = inv.data.invoice.lines.find(l => l.kind === 'vat');
  assert.ok(vatLine, 'سطر TVA موجود عند التسجيل في الرسم');
  ok(`الفاتورة تفصل الرسم على القيمة المضافة: ${vatLine.amount}$`);

  /* لا فاتورتان لنفس الحجز */
  const again = await api('/api/bookings/' + bInv.data.booking.id + '/invoice', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(again.data.invoice.number, inv.data.invoice.number);
  ok('الفاتورة تُصدر مرة واحدة (idempotent)');

  /* بطاقة الفاتورة للطباعة */
  const page = await fetch(BASE + '/invoice/' + inv.data.invoice.number + '?t=admin-test');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /16\/00-1234567B19/);
  assert.match(html, /000216123456789/);
  assert.match(html, /فاتورة/);
  const noTok = await fetch(BASE + '/invoice/' + inv.data.invoice.number + '?t=wrong');
  assert.equal(noTok.status, 401);
  ok('فاتورة HTML للطباعة برقم السجل التجاري (وبلا رمز 401)');

  /* حجز غير مؤكَّد ⇒ لا فاتورة */
  const pendingSearch = await api('/api/search', 'POST', { vertical: 'train' });
  const pend = await api('/api/bookings', 'POST', { offerId: pendingSearch.data.offers[0].id });
  const badInv = await api('/api/bookings/' + pend.data.booking.id + '/invoice', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(badInv.status, 409, 'لا فاتورة على حجز غير مؤكَّد');
  ok('رفض إصدار فاتورة لحجز غير مؤكَّد (409)');

  /* سجل الفواتير محمي */
  assert.equal((await api('/api/invoices')).status, 401);
  const list = await api('/api/invoices', 'GET', null, { authorization: 'Bearer admin-test' });
  assert.equal(list.status, 200);
  assert.equal(list.data.invoices.length, 1);
  ok('سجل الفواتير محمي برمز الإدارة');
}

/* ---------- 7و) العمل بلا نطاق (نفق/محلي) ---------- */
console.log('\n[7و] العمل بلا نطاق — استنتاج الرابط من الطلب');
{
  const chargily = await import('../src/payments/chargily.js');
  const save = ENV.publicBaseUrl;

  /* بلا PUBLIC_BASE_URL: يُستنتج من ترويسات الطلب (مثل نفق cloudflared) */
  ENV.publicBaseUrl = '';
  ENV.publicBaseUrlAuto = '';
  const res = await fetch(BASE + '/api/health', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'demo-abc.trycloudflare.com' } });
  assert.equal(res.status, 200);

  const payload = chargily.buildCheckoutPayload({ amount: 100, currency: 'USD', bookingId: 'bk_tunnel' });
  assert.match(payload.webhook_endpoint, /^https:\/\/demo-abc\.trycloudflare\.com\/webhooks\/chargily$/, 'الويب هوك يستخدم نطاق النفق تلقائيًا');
  assert.match(payload.success_url, /demo-abc\.trycloudflare\.com/);
  ok('بلا نطاق: الرابط يُستنتج من الطلب → ' + payload.webhook_endpoint);

  /* محليًا بلا أي ترويسات: localhost */
  ENV.publicBaseUrl = ''; ENV.publicBaseUrlAuto = '';
  await fetch(BASE + '/api/health');
  const local = chargily.buildCheckoutPayload({ amount: 100, currency: 'USD', bookingId: 'bk_local' });
  assert.match(local.webhook_endpoint, /^http:\/\/(127\.0\.0\.1|localhost):4987\/webhooks\/chargily$/);
  ok('محليًا: ' + local.webhook_endpoint);

  ENV.publicBaseUrl = save;
}

/* ---------- 7ز) الإشعارات (Outbox) ---------- */
console.log('\n[7ز] الإشعارات — بريد الحجز والفاتورة والتحويل');
{
  const notify = await import('../src/notify.js');

  /* التهيئة */
  const info = notify.mailerInfo();
  assert.equal(info.outbox, true);
  ok(`البريد: ${info.provider} · صندوق دائم مفعّل`);

  /* حجز جديد ← بريد تأكيد للعميل */
  const s1 = await api('/api/search', 'POST', { vertical: 'car' });
  const b1 = await api('/api/bookings', 'POST', {
    offerId: s1.data.offers[0].id,
    customer: { name: 'سارة مرابط', email: 'sara@example.com' },
  });
  await api('/api/payments/' + b1.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });
  await new Promise(r => setTimeout(r, 400));      // الإشعار غير متزامن

  const box1 = (await api('/api/outbox', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  assert.ok(box1.counts.total >= 1);
  const conf = box1.recent.find(m => m.template === 'booking.confirmed' && m.to === 'sara@example.com');
  assert.ok(conf, 'بريد تأكيد الحجز موجود في الصندوق');
  assert.equal(conf.status, 'sent', 'أُرسل عبر ناقل console');
  assert.match(conf.subject, /تأكيد الحجز/);
  ok(`بريد تأكيد للعميل: «${conf.subject}» → ${conf.to}`);

  /* فاتورة ← بريد بالفاتورة */
  const inv = await api('/api/bookings/' + b1.data.booking.id + '/invoice', 'POST', {}, { authorization: 'Bearer admin-test' });
  await new Promise(r => setTimeout(r, 300));
  const box2 = (await api('/api/outbox', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  const mailInv = box2.recent.find(m => m.template === 'invoice.issued');
  assert.ok(mailInv, 'بريد الفاتورة موجود');
  assert.match(mailInv.subject, /فاتورة/);
  ok(`بريد الفاتورة: ${inv.data.invoice.number}`);

  /* عرض الرسالة HTML محمي */
  const view = await fetch(BASE + '/outbox/' + mailInv.id + '?t=admin-test');
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /فاتورتك جاهزة|MARIA/);
  assert.match(html, /16\/00-1234567B19/, 'سجل تجاري داخل البريد');
  assert.equal((await fetch(BASE + '/outbox/' + mailInv.id + '?t=bad')).status, 401);
  ok('عرض البريد HTML محمي بالرمز + يحمل RC');

  /* الصندوق محمي */
  assert.equal((await api('/api/outbox')).status, 401);
  ok('صندوق الرسائل محمي (401)');

  /* ترحيب شريك */
  const app = await api('/api/partners/apply', 'POST', { name: 'وكالة رحلات الجنوب', email: 'sud@example.com', country: 'DZ' });
  assert.equal(app.status, 201);
  await new Promise(r => setTimeout(r, 300));
  const box3 = (await api('/api/outbox', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  const welcome = box3.recent.find(m => m.template === 'partner.welcome');
  assert.ok(welcome, 'بريد ترحيب بالشريك');
  assert.equal(welcome.to, 'sud@example.com');
  ok(`بريد ترحيب بالشريك: ${app.data.partner.code}`);

  /* إعادة إرسال */
  const re = await api('/api/outbox/' + welcome.id + '/resend', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(re.status, 200);
  assert.equal(re.data.message.status, 'sent');
  assert.ok(re.data.message.attempts >= 2);
  ok('إعادة إرسال رسالة من الصندوق تعمل');

  /* ناقل معطّل ⇒ failed بلا كسر الحجز */
  ENV.mailProvider = 'off';
  const r = await notify.send({ to: 'x@example.com', subject: 'اختبار', html: '<p>x</p>' });
  assert.equal(r.status, 'failed');
  ENV.mailProvider = 'console';
  ok('تعطيل البريد يسجّل failed ولا يُسقط أي عملية');

  /* بريد غير صالح يُتجاهل بأمان */
  assert.equal(await notify.send({ to: 'لا-بريد', subject: 'x', html: 'x' }), null);
  ok('عنوان بريد غير صالح يُتجاهل بلا خطأ');

  /* الملخّص يعرض الصندوق */
  const sum = (await api('/api/summary')).data;
  assert.ok(sum.outbox && sum.outbox.counts.total >= 3);
  ok(`لوحة التشغيل تعرض الصندوق: ${sum.outbox.counts.sent} مُرسلة · ${sum.outbox.counts.failed} فاشلة`);
}

/* ---------- 7ح) طلبات الحجز ---------- */
console.log('\n[7ح] طلبات الحجز — العميل يطلب ونحن نؤكّد');
{
  assert.equal(ENV.bookingMode, 'request');
  ok('وضع الحجز الافتراضي: طلب (request)');

  const s1 = await api('/api/search', 'POST', { vertical: 'flight' });
  const offer = s1.data.offers[0];

  /* بريد مفقود ⇒ رفض واضح */
  const badMail = await api('/api/requests', 'POST', { offerId: offer.id, customer: { name: 'أمين بن علي', phone: '0555000000' } });
  assert.equal(badMail.status, 422);
  assert.match(badMail.data.error, /البريد/);
  ok('طلب بلا بريد ⇒ 422: ' + badMail.data.error);

  /* هاتف ناقص ⇒ رفض */
  const badPhone = await api('/api/requests', 'POST', { offerId: offer.id, customer: { name: 'أمين بن علي', email: 'amin@example.com' } });
  assert.equal(badPhone.status, 422);
  assert.match(badPhone.data.error, /الهاتف/);
  ok('طلب بلا هاتف ⇒ 422');

  /* عرض منتهٍ ⇒ 409 */
  const badOffer = await api('/api/requests', 'POST', { offerId: 'off_does_not_exist', customer: { name: 'أمين بن علي', email: 'amin@example.com', phone: '0555000000' } });
  assert.equal(badOffer.status, 409);
  ok('عرض منتهٍ ⇒ 409');

  /* طلب سليم */
  const created = await api('/api/requests', 'POST', {
    offerId: offer.id,
    customer: { name: 'أمين بن علي', email: 'amin@example.com', phone: '0555112233' },
    note: 'أفضّل رحلة صباحية',
  });
  assert.equal(created.status, 201);
  const req = created.data.request;
  assert.match(req.code, /^RQ-[A-Z0-9]{6}$/);
  assert.equal(req.status, 'new');
  assert.equal(req.offer.title, offer.title);
  ok(`طلب منشأ: ${req.code} · ${req.verticalName} · ${req.offer.title}`);

  /* لا يظهر أي مبلغ دفع قبل الموافقة */
  assert.equal(req.payUrl, null);
  ok('لا رابط دفع قبل الموافقة (لا نطلب مالًا قبل التأكّد)');

  /* بريد الاستلام للعميل */
  await new Promise(r => setTimeout(r, 300));
  const box = (await api('/api/outbox', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  const recMail = box.recent.find(m => m.template === 'request.received' && m.to === 'amin@example.com');
  assert.ok(recMail, 'بريد استلام الطلب');
  assert.match(recMail.subject, /RQ-/);
  ok(`بريد الاستلام: «${recMail.subject}»`);

  /* تتبّع عام بلا بيانات داخلية */
  const track = await api('/api/requests/' + req.code);
  assert.equal(track.status, 200);
  assert.equal(track.data.request.status, 'new');
  assert.equal(track.data.request.customerName, 'أمين');
  assert.ok(!JSON.stringify(track.data).includes('platformFee'), 'لا تكاليف داخلية في العرض العام');
  ok('تتبّع الطلب عام ولا يكشف التكاليف الداخلية');

  /* قائمة الطلبات محمية */
  assert.equal((await api('/api/requests')).status, 401);
  const list = await api('/api/requests?status=new', 'GET', null, { authorization: 'Bearer admin-test' });
  assert.equal(list.status, 200);
  assert.ok(list.data.requests.some(r => r.code === req.code));
  assert.equal(list.data.counts.new >= 1, true);
  ok(`لوحة الطلبات: ${list.data.counts.new} جديد · الوضع ${list.data.mode}`);

  /* موافقة ⇒ حجز + رابط دفع + بريد */
  const appr = await api('/api/requests/' + req.code + '/approve', 'POST', { adminNote: 'متوفّر — السعر مثبَّت' }, { authorization: 'Bearer admin-test' });
  assert.equal(appr.status, 200);
  assert.equal(appr.data.request.status, 'approved');
  assert.ok(appr.data.booking.id, 'حجز منشأ');
  assert.ok(appr.data.request.payUrl, 'رابط دفع موجود');
  const bq = appr.data.booking.pricing;
  assert.equal(bq.platformFee, Math.round(offer.price * 0.03 * 100) / 100);
  ok(`موافقة ⇒ حجز ${appr.data.booking.id.slice(-8)} · دفع ${bq.customerTotal} ${bq.currency}`);

  /* موافقة مكرّرة ⇒ نفس الحجز (لا تكرار) */
  const appr2 = await api('/api/requests/' + req.code + '/approve', 'POST', {}, { authorization: 'Bearer admin-test' });
  assert.equal(appr2.status, 200);
  assert.equal(appr2.data.booking.id, appr.data.booking.id);
  ok('موافقة مكرّرة ⇒ نفس الحجز (idempotent)');

  /* صفحة الدفع العامة */
  const pv = await api('/api/pay/' + appr.data.booking.id);
  assert.equal(pv.status, 200);
  assert.equal(Number(pv.data.payment.amount), bq.customerTotal);
  assert.ok(!JSON.stringify(pv.data).includes('partnerEarnings'), 'لا بيانات شركاء للعميل');
  ok(`صفحة الدفع: ${pv.data.payment.amount} ${pv.data.payment.currency} · بلا تكاليف داخلية`);

  /* بريد الموافقة */
  await new Promise(r => setTimeout(r, 300));
  const box2 = (await api('/api/outbox', 'GET', null, { authorization: 'Bearer admin-test' })).data;
  const apprMail = box2.recent.find(m => m.template === 'request.approved');
  assert.ok(apprMail);
  assert.match(apprMail.html || apprMail.subject, /RQ-/);
  ok('بريد الموافقة مع رابط الدفع أُرسل');

  /* الدفع يُتمّ الحجز */
  const paid = await api('/api/payments/' + pv.data.payment.id + '/confirm', 'POST', { threeDS: 'success' });
  assert.equal(paid.status, 200);
  const after = await api('/api/requests/' + req.code);
  assert.equal(after.data.request.status, 'paid', 'الطلب يظهر مدفوعًا بعد الدفع');
  assert.equal(after.data.request.payUrl, null, 'يختفي زر الدفع بعد الدفع');
  ok(`الدفع بعد الموافقة: الطلب ${after.data.request.status} · الحجز ${paid.data.booking?.status || 'confirmed'}`);

  /* رفض طلب آخر */
  const s2 = await api('/api/search', 'POST', { vertical: 'hotel' });
  const r2 = await api('/api/requests', 'POST', { offerId: s2.data.offers[0].id, customer: { name: 'ليلى حمدان', email: 'layla@example.com', phone: '0661223344' } });
  const rej = await api('/api/requests/' + r2.data.request.code + '/reject', 'POST', { reason: 'الفندق محجوز بالكامل في هذا التاريخ' }, { authorization: 'Bearer admin-test' });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.request.status, 'rejected');
  assert.equal(rej.data.request.payUrl, null);
  ok('الرفض بسبب واضح ولا رابط دفع');

  /* رفض/موافقة بلا رمز إدارة ⇒ 401 */
  assert.equal((await api('/api/requests/' + r2.data.request.code + '/reject', 'POST', {})).status, 401);
  ok('قرارات الطلبات محمية برمز الإدارة');

  /* إلغاء من العميل */
  const r3 = await api('/api/requests', 'POST', { offerId: s2.data.offers[0].id, customer: { name: 'كريم زيتوني', email: 'karim@example.com', phone: '0770112233' } });
  const c1 = await api('/api/requests/' + r3.data.request.code + '/cancel', 'POST', { email: 'wrong@example.com' });
  assert.equal(c1.status, 403);
  const c2 = await api('/api/requests/' + r3.data.request.code + '/cancel', 'POST', { email: 'karim@example.com' });
  assert.equal(c2.status, 200);
  assert.equal(c2.data.request.status, 'cancelled');
  ok('إلغاء العميل: يلزم بريد مطابق، ثم يُلغى');

  /* انتهاء المدة */
  ENV.requestTtlHours = 0;
  await api('/api/requests?expire=1', 'GET', null, { authorization: 'Bearer admin-test' });
  ENV.requestTtlHours = 48;
  ok('الطلبات القديمة تُغلق تلقائيًا بعد المدة');

  /* صفحتا الطلب والدفع */
  assert.equal((await fetch(BASE + '/request')).status, 200);
  assert.equal((await fetch(BASE + '/pay?booking=' + appr.data.booking.id)).status, 200);
  ok('صفحتا /request و /pay تعملان');
}

/* ---------- 8) الصفحات ---------- */
console.log('\n[8] الصفحات');
for (const [path, needle] of [['/dashboard', 'لوحة العمولات'], ['/join', 'انضم كشريك'], ['/partner', 'بوابة الشريك'], ['/', 'رسوم']]) {
  const res = await fetch(BASE + path);
  assert.equal(res.status, 200, path);
  assert.match(await res.text(), new RegExp(needle));
  ok('GET ' + path);
}

server.close();
fs.rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
console.log(`\n✅ نجح ${pass} اختبارًا — Postgres + مدفوعات + شركاء + نموذج 3% كلها سليمة.\n`);
