/**
 * فحص مفتاح Duffel الحقيقي — شغّله بعد وضع المفتاح في .env
 *   node test/duffel-check.mjs            # فحص محلي بلا شبكة
 *   node test/duffel-check.mjs --live     # بحث حقيقي على api.duffel.com
 *
 * لا يُنشئ أي طلب (لا يُخصم رصيد). يبحث فقط ويتحقّق من الصلاحيات.
 */
process.env.MARIA_MODE ??= 'live';

const { ENV } = await import('../src/config.js');
const duffel = await import('../src/adapters/duffel.js');

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };
const info = (m) => console.log('  · ' + m);

console.log('\n═══ فحص Duffel — ماريا ═══\n');

/* 1) الإعدادات */
console.log('— الإعدادات —');
ENV.duffelKey ? ok('DUFFEL_API_KEY مضبوط (' + ENV.duffelKey.slice(0, 14) + '…)') : bad('DUFFEL_API_KEY غير مضبوط');
const mode = duffel.keyMode();
mode === 'test' ? ok('المفتاح: بيئة اختبار (لا أموال حقيقية)')
  : mode === 'live' ? console.log('  ⚠ المفتاح: إنتاج حقيقي — أي طلب يُخصم من رصيدك!')
  : bad('صيغة مفتاح غير معروفة (يبدأ بـ duffel_test_ أو duffel_live_)');
ENV.mode === 'live' ? ok('MARIA_MODE=live') : bad('MARIA_MODE ليس live — لن يُستعمل المفتاح');
info('الإصدار: ' + ENV.duffelVersion + ' · الخادم: ' + ENV.duffelBaseUrl);
info('رسوم Duffel: 3$ لكل طلب + 1% (تُحتسب في تسعير ماريا)');

const caps = duffel.capabilities();
caps.live ? ok('المسار الحقيقي مفعّل') : bad('المسار الحقيقي غير مفعّل');

/* 2) تحقّق محلي من منطق الحماية (بلا شبكة) */
console.log('\n— حمايات مبرمجة (بلا شبكة) —');
/* نُفعّل المسار لحظة الفحص فقط: التحقّق يحدث قبل أي اتصال شبكي */
const savedKey = ENV.duffelKey, savedMode = ENV.mode;
ENV.duffelKey = ENV.duffelKey || 'duffel_test_local_check';
ENV.mode = 'live';

let e1 = null;
try { await duffel.book({ offer: { supplierRef: 'x' }, passengers: [], amount: 100 }); } catch (e) { e1 = e.message; }
e1 ? ok('يرفض الحجز بلا مسافرين: ' + e1.slice(0, 48)) : bad('لم يرفض الحجز بلا مسافرين');

let e2 = null;
try { await duffel.book({ offer: { supplierRef: 'x' }, passengers: [{ given_name: 'A', family_name: 'B' }], amount: 100 }); } catch (e) { e2 = e.message; }
e2 && /تاريخ الميلاد/.test(e2) ? ok('يشرح الناقص بدقة: ' + e2.slice(0, 52)) : bad('لا يشرح الحقول الناقصة');

/* إعادة الحالة الحقيقية */
ENV.duffelKey = savedKey;
ENV.mode = savedMode;

/* 3) بحث حقيقي */
if (process.argv.includes('--live')) {
  console.log('\n— بحث حقيقي على Duffel —');
  const date = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  try {
    const offers = await duffel.search({ origin: 'ALG', destination: 'CDG', departureDate: date, adults: 1 });
    if (!offers.length) { bad('البحث نجح لكن لا عروض لهذا الخط/التاريخ'); }
    else {
      ok(`البحث يعمل: ${offers.length} عرض لـ ALG→CDG في ${date}`);
      const o = offers[0];
      info(`أرخص عرض: ${o.title} · ${o.subtitle} · ${o.price} ${o.currency}`);
      info(`ينتهي في: ${o.expiresAt || 'غير محدّد'} · قابل للاسترداد: ${o.refundable ? 'نعم' : 'لا'}`);
      info(`بيئة العرض: ${o.live ? 'إنتاج' : 'اختبار'}`);
      const cut = o.price * 0.03 + o.price * 0.045 - 3 - o.price * 0.01;
      info(`صافي ماريا المتوقّع على هذا العرض ≈ ${cut.toFixed(2)} $ (3% + هامش − رسوم Duffel)`);
    }
  } catch (e) {
    bad('فشل البحث: ' + e.message);
    if (/401/.test(e.message)) info('⇒ المفتاح مرفوض: تأكّد من نسخه كاملًا بلا مسافات');
    if (/422/.test(e.message)) info('⇒ التاريخ ماضٍ أو رمز المطار غير صحيح (ALG, CDG, IST…)');
  }
} else {
  console.log('\n  (أضف --live لبحث حقيقي على خوادم Duffel)');
}

console.log('\n' + (process.exitCode ? '⚠️ أصلح ما سبق قبل الحجز الحقيقي.\n' : '✅ Duffel جاهز — أول حجز طيران حقيقي ممكن الآن.\n'));
