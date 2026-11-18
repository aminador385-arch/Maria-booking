/**
 * اختبار مسار Duffel الحقيقي (بدون مفتاح حقيقي).
 * يشغّل محاكي Sandbox محليًا، ثم يستدعي **نفس كود التكامل** المستخدم مع api.duffel.com.
 * الفرق الوحيد عند الإنتاج: DUFFEL_BASE_URL غير مضبوط + مفتاح حقيقي.
 *
 * التشغيل: npm run test:duffel
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const SIM_PORT = 4555;
let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

/* 1) تشغيل المحاكي */
const sim = spawn(process.execPath, ['src/tools/duffel-sim.js'], {
  env: { ...process.env, DUFFEL_SIM_PORT: String(SIM_PORT), DUFFEL_SIM_KEY: 'test_key' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('المحاكي تأخّر')), 8000);
  sim.stdout.on('data', (d) => { if (String(d).includes('Simulator')) { clearTimeout(t); resolve(); } });
  sim.stderr.on('data', (d) => process.stderr.write(d));
});

/* 2) ضبط متغيّرات البيئة قبل تحميل الإعدادات */
process.env.DUFFEL_BASE_URL = `http://127.0.0.1:${SIM_PORT}`;
process.env.DUFFEL_API_KEY = 'test_key';
process.env.MARIA_MODE = 'live';
process.env.PGLITE_DIR = '/tmp/maria-duffel-test';

const { default: duffel } = { default: await import('../src/adapters/duffel.js') };

console.log('\n[Duffel] مسار التكامل الحقيقي عبر محاكي Sandbox');

try {
  const caps = duffel.capabilities();
  assert.equal(caps.live, true, 'يجب أن يكون live=true عند وجود مفتاح + MARIA_MODE=live');
  ok('capabilities: live=true');

  const offers = await duffel.search({ origin: 'ALG', destination: 'CDG', departureDate: '2026-11-12', adults: 2 });
  assert.ok(offers.length >= 3, 'يجب أن ترجع عروض');
  assert.equal(offers[0].source, 'duffel');
  assert.ok(offers[0].price > 0);
  assert.match(offers[0].subtitle, /·/);
  ok(`search حقيقي: ${offers.length} عرض · أولها ${offers[0].title} ${offers[0].subtitle} @ ${offers[0].price}$`);

  /* 3) إنشاء طلب حقيقي (Order) مع بيانات مسافر */
  const order = await duffel.book({
    offer: offers[0],
    passengers: [{ id: 'pas_1', name: { given_name: 'Amin', family_name: 'Benali' }, email: 'amin@example.com', phone_number: '+213555000000', born_on: '1990-01-01', gender: 'm', title: 'mr' }],
    amount: offers[0].price,
    currency: 'USD',
  });
  assert.equal(order.status, 'confirmed');
  assert.match(order.providerRef, /^SIM/);
  ok(`order مُنشأ لدى المزوّد: ${order.providerRef} · status=${order.status}`);

  /* 4) رفض بيانات مسافر ناقصة (تحقّق من الحماية) */
  await assert.rejects(() => duffel.book({ offer: offers[0], passengers: [] }), /بيانات المسافر/);
  ok('رفض الحجز بلا بيانات مسافر');

  /* 4ب) رفض مسافر ناقص تاريخ الميلاد برسالة عربية دقيقة */
  let fieldErr = null;
  try {
    await duffel.book({ offer: offers[0], passengers: [{ given_name: 'Amin', family_name: 'Benali' }], amount: 100, currency: 'USD' });
  } catch (e) { fieldErr = e.message; }
  assert.match(String(fieldErr), /تاريخ الميلاد/);
  ok('رسالة دقيقة للناقص: ' + fieldErr);

  /* 4ج) Idempotency: نفس المفتاح ⇒ نفس الطلب (لا حجز مزدوج) */
  const P = [{ given_name: 'Amin', family_name: 'Benali', born_on: '1990-01-01', gender: 'm', email: 'amin@example.com', phone_number: '+213555000000' }];
  const o1 = await duffel.book({ offer: offers[0], passengers: P, amount: 244, currency: 'USD', idempotencyKey: 'maria-idem-1' });
  const o2 = await duffel.book({ offer: offers[0], passengers: P, amount: 244, currency: 'USD', idempotencyKey: 'maria-idem-1' });
  assert.equal(o1.orderId, o2.orderId, 'نفس الطلب لنفس المفتاح');
  ok(`Idempotency: ${o1.providerRef} = ${o2.providerRef} (لا تكرار)`);

  /* 4د) استرجاع الطلب + مطابقته */
  const got = await duffel.getOrder(o1.orderId);
  assert.equal(got.status, 'confirmed');
  assert.equal(got.providerRef, o1.providerRef);
  ok(`getOrder: ${got.providerRef} · ${got.status} · ${got.totalAmount} ${got.currency}`);

  /* 4هـ) إلغاء الطلب مع مبلغ الاسترداد */
  const cancel = await duffel.cancelOrder(o1.orderId);
  assert.equal(cancel.status, 'cancelled');
  assert.equal(cancel.refundAmount, 199);
  ok(`إلغاء لدى المزوّد: مسترد ${cancel.refundAmount} ${cancel.refundCurrency}`);

  /* 4و) عرض منتهي ⇒ رسالة عربية واضحة */
  let expiredMsg = null;
  try {
    await duffel.book({ offer: { ...offers[0], supplierRef: 'off_expired_123' }, passengers: P, amount: 244, currency: 'USD' });
  } catch (e) { expiredMsg = e.message; }
  assert.match(String(expiredMsg), /انتهت صلاحية/);
  ok('عرض منتهٍ → رسالة مفهومة: ' + expiredMsg);

  /* 4ز) اكتشاف نوع المفتاح */
  process.env.DUFFEL_API_KEY = 'duffel_test_abc';
  const { ENV: E2 } = await import('../src/config.js');
  E2.duffelKey = 'duffel_test_abc';
  assert.equal(duffel.keyMode(), 'test');
  E2.duffelKey = 'duffel_live_xyz';
  assert.equal(duffel.keyMode(), 'live');
  ok('اكتشاف نوع المفتاح: test / live');

  /* 4ح) استرجاع عرض محدّد (بمفتاح صالح) */
  E2.duffelKey = 'test_key';
  const { ENV: E3 } = await import('../src/config.js');
  E3.duffelKey = 'test_key';
  const one = await duffel.getOffer('off_sim_1');
  assert.ok(one.price > 0);
  ok(`getOffer: ${one.price} ${one.currency}`);

  /* 5) مفتاح خاطئ → خطأ واضح من المزوّد */
  process.env.DUFFEL_API_KEY = 'wrong_key';
  const { ENV } = await import('../src/config.js');
  ENV.duffelKey = 'wrong_key';
  await assert.rejects(() => duffel.search({ origin: 'ALG', destination: 'CDG' }), /401|Unauthorized/);
  ok('مفتاح خاطئ → 401 من المزوّد (رسالة واضحة)');

  console.log(`\n✅ نجح ${pass} اختبارًا — كود Duffel جاهز للإنتاج: ضع المفتاح الحقيقي وأزل DUFFEL_BASE_URL.\n`);
} finally {
  sim.kill();
}
