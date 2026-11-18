/**
 * فحص جاهزية Chargily — شغّله بعد وضع المفاتيح في .env
 *   node test/chargily-check.mjs            # فحص محلي (بلا شبكة)
 *   node test/chargily-check.mjs --live     # + نداء حقيقي لواجهة Chargily
 *
 * يتحقّق من: وجود المفتاح · بناء جسم checkout صحيح · تطابق التوقيع · صفحة العودة
 * لا يُصدر أي دفع حقيقي في وضع الاختبار.
 */
import crypto from 'node:crypto';
process.env.CHARGILY_TEST ??= 'true';

const { ENV, MODEL, LEGAL } = await import('../src/config.js');
const chargily = await import('../src/payments/chargily.js');

const line = (m) => console.log('  ' + m);
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };
let pass = 0;

console.log('\n═══ فحص Chargily — ماريا ═══\n');

/* 1) المفاتيح والإعدادات */
line('— الإعدادات —');
ENV.chargilyKey ? ok('CHARGILY_SECRET_KEY مضبوط (' + ENV.chargilyKey.slice(0, 7) + '…)') : bad('CHARGILY_SECRET_KEY غير مضبوط');
ok('الوضع: ' + (ENV.chargilyTest ? 'اختبار (test)' : 'حقيقي (live)'));
ok('الرسوم على: ' + ENV.chargilyFeesAllocation);
ok('القناة الافتراضية: ' + ENV.chargilyMethod);
ok('سعر التحويل: 1$ = ' + ENV.dzdPerUsd + ' دج');
LEGAL.ready ? ok('الهوية القانونية جاهزة (RC + NIF) للفوترة') : bad('الهوية القانونية ناقصة: ' + [LEGAL.rc ? null : 'MARIA_RC_NUMBER', LEGAL.nif ? null : 'MARIA_NIF'].filter(Boolean).join(' · '));

/* 2) جسم الـcheckout */
line('\n— بناء checkout بحجز حقيقي المثال —');
const q = { basePrice: 260, platformFee: 7.8, total: 267.8 };
try {
  const p = chargily.buildCheckoutPayload({ amount: q.total, currency: MODEL.currency, bookingId: 'bk_check' });
  ok(`المبلغ: ${q.total}$ = ${p.amount} دج`);
  p.amount === Math.round(q.total * ENV.dzdPerUsd) ? ok('التحويل إلى الدينار صحيح') : bad('تحويل الدينار خطأ');
  p.currency === 'dzd' ? ok('العملة dzd') : bad('العملة غير صحيحة');
  p.locale === 'ar' ? ok('صفحة الدفع بالعربية') : bad('اللغة غير عربية');
  p.chargily_pay_fees_allocation === 'merchant' ? ok('رسوم Chargily على المنصة (لا زيادة خفية على العميل)') : ok('الرسوم على: ' + p.chargily_pay_fees_allocation);
  p.webhook_endpoint === ENV.publicBaseUrl + '/webhooks/chargily'
    ? ok('Webhook: ' + p.webhook_endpoint)
    : bad('Webhook لا يشير إلى النطاق الصحيح — اضبط PUBLIC_BASE_URL (الحالي: ' + ENV.publicBaseUrl + ')');
  p.success_url.includes('/pay/success') ? ok('صفحة النجاح مربوطة') : bad('success_url ناقص');
  pass++;
} catch (e) { bad('بناء الـcheckout فشل: ' + e.message); }

/* 3) التوقيع */
line('\n— توقيع الـWebhook —');
const raw = JSON.stringify({ type: 'checkout.paid', data: { id: 'chk_sim' } });
const sig = crypto.createHmac('sha256', ENV.chargilyKey || 'none').update(raw, 'utf8').digest('hex');
chargily.verifyWebhook(raw, sig).ok ? ok('توقيع صحيح → مقبول') : bad('توقيع صحيح رُفض — تحقّق من المفتاح');
chargily.verifyWebhook(raw, 'deadbeef').ok === false ? ok('توقيع مزوَّر → مرفوض') : bad('توقيع مزوَّر قُبل! خطر أمني');

/* 4) نداء حقيقي (اختياري) */
if (process.argv.includes('--live')) {
  line('\n— نداء Chargily الحقيقي —');
  try {
    const res = await fetch((ENV.chargilyTest ? 'https://pay.chargily.net/test/api/v2' : 'https://pay.chargily.net/api/v2') + '/balance', {
      headers: { Authorization: 'Bearer ' + ENV.chargilyKey },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const b = await res.json();
      ok('المفتاح صالح — الرصيد: ' + JSON.stringify(b).slice(0, 160));
    } else {
      bad('المفتاح مرفوض (HTTP ' + res.status + ') — تأكّد أنك في الوضع الصحيح (test/live)');
    }
  } catch (e) { bad('تعذّر الوصول إلى Chargily: ' + e.message); }
} else {
  line('\n(أضف --live للتحقّق من المفتاح مع خوادم Chargily)');
}

console.log('\n' + (process.exitCode ? '⚠️ توجد مشاكل أعلاه — أصلحها قبل الإطلاق.\n' : '✅ Chargily جاهز للاختبار الحقيقي.\n'));
