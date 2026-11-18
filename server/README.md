# ماريا — خادم الحجز والعمولات v2

**Postgres + مدفوعات + تسجيل شركاء ذاتي + نموذج 3%** — بلا أي إطار عمل، Node.js فقط.

```bash
cd server
npm install      # لأول مرة (pg + PGlite)
npm start        # http://localhost:4173
npm test         # 28 اختبارًا: محاسبة + مدفوعات + شركاء + أمان Webhook
npm run test:duffel   # اختبار مسار Duffel الحقيقي عبر محاكي Sandbox
```

| الصفحة | الرابط |
|---|---|
| واجهة الحجز | `/` |
| لوحة التشغيل والعمولات | `/dashboard` |
| تسجيل شريك ذاتي | `/join` |
| بوابة الشريك | `/partner` |

---

## 1) قاعدة البيانات: Postgres حقيقي

- **بدون إعداد** → **PGlite**: نفس Postgres مُجمَّعًا إلى WASM داخل العملية (ملف على القرص في `data/pglite`).
- **للإنتاج** → ضع `DATABASE_URL=postgres://…` فينتقل الكود تلقائيًا إلى حزمة `pg` بلا تغيير سطر واحد.

المخطط في `src/db/schema.sql`: `partners`, `bookings`, `ledger_entries`, `payments`, `payouts`, `idempotency`, `webhook_events`, `audit_events`.
كل الوصول عبر `src/db/repo.js` (SQL فقط، معاملات مُهيّأة للمنطق المالي).

## 2) المدفوعات

| المزوّد | الاستعمال | ما هو مكتوب فعليًا |
|---|---|---|
| `none` | **وضع الإحالة** — بلا استلام أموال عملاء | حجز `referred` + رابط إحالة؛ العمولة تُثبَّت لاحقًا عبر `POST /api/bookings/:id/reconcile` |
| `sandbox` (افتراضي) | تجربة كاملة بلا مفاتيح | نية دفع → **3DS** → نجاح/فشل/رفض بطاقة (`0002`) → **استرداد** |
| `stripe` | الإنتاج | `payment_intents` عبر REST + `refunds` + **تحقّق توقيع Webhook** (HMAC‑SHA256 + منع replay) |

**المسار الصارم:** بحث → `POST /api/bookings` (ينشئ حجزًا `pending` + نية دفع) → تأكيد الدفع → **ثم فقط** تنفيذ الحجز لدى المزوّد → تأكيد → قيد العمولة.
إذا فشل المزوّد بعد نجاح الدفع ⇒ **استرداد تلقائي** + إلغاء.
الإلغاء بعد الدفع ⇒ استرداد فعلي + **قيد عكس** في الدفتر.

```bash
# مثال كامل في وضع sandbox
OFFER=$(curl -s -X POST localhost:4173/api/search -H 'content-type: application/json' \
  -d '{"vertical":"hotel","ref":"AGENCY-DZ"}' | jq -r '.offers[0].id')
BOOK=$(curl -s -X POST localhost:4173/api/bookings -H 'content-type: application/json' \
  -d "{\"offerId\":\"$OFFER\",\"ref\":\"AGENCY-DZ\",\"idempotencyKey\":\"k1\"}")
PID=$(echo $BOOK | jq -r '.payment.id')
curl -s -X POST localhost:4173/api/payments/$PID/confirm -H 'content-type: application/json' -d '{"threeDS":"success"}'
```

## 3) تسجيل الشركاء ذاتيًا + بوابة الشريك

```bash
# 1) تسجيل (public)
POST /api/partners/apply  {name, type, email, phone, country, payoutMethod}
   → {partner:{code,status}, apiKey, referralLink}

# 2) الموافقة (إدارة — يتطلب Bearer <MARIA_ADMIN_TOKEN>)
POST /api/partners/:code/approve

# 3) دخول الشريك
POST /api/partner/login  {code, email} → {token}
GET  /api/partner/me     Authorization: Bearer <apiKey> → ملخّصه الكامل

# 4) البيع بكوده
POST /api/search   {vertical, ref:"CODE"}
POST /api/bookings {offerId, ref:"CODE", idempotencyKey}
```

- `MARIA_AUTO_APPROVE=true` (افتراضي في التجربة) ⇒ تفعيل فوري.
- `=false` ⇒ الشريك `pending`، وأي محاولة بيع بكوده تُرجع **403** حتى الموافقة (KYC).

## 4) Duffel — مسار حقيقي مُختبَر بلا مفتاح

```bash
npm run duffel:sim     # محاكي يتصرّف مثل api.duffel.com (منفذ 4555)
DUFFEL_BASE_URL=http://127.0.0.1:4555 DUFFEL_API_KEY=test MARIA_MODE=live npm start
npm run test:duffel    # 5 اختبارات على نفس كود الإنتاج
```

`test/duffel.live.mjs` يثبت: `offer_requests` → `orders` (طلب فعلي بمعرّف حجز) → رفض بيانات المسافر الناقصة → **401 عند مفتاح خاطئ**.
**للإنتاج:** احذف `DUFFEL_BASE_URL` وضع `DUFFEL_API_KEY` الحقيقي — لا يتغيّر أي كود.

## 5) المعادلات (المصدر: `src/pricing.js`)

```
رسوم العميل   = سعر المزوّد × 3%
إجمالي العميل = سعر المزوّد + 3%
عمولة المزوّد = سعر المزوّد × نسبة القطاع      (4.5% طيران … 15% صحة)
تكلفة المزوّد = 3$ + 1% (Duffel فقط)
حصة الشريك    = رسوم 3% × 50%                  (1.5% من قيمة الحجز)
صافي المنصة   = (3% − حصة الشريك) + عمولة المزوّد − تكلفة المزوّد
```

| حالة | رسوم 3% | عمولة المزوّد | صافي المنصة | الهامش |
|---|---|---|---|---|
| فندق 1,000$ مباشر | 30$ | 120$ | **150$** | 15% |
| فندق 1,000$ عبر شريك | 30$ | 120$ | **135$** | 13.5% |
| طيران 260$ | 7.8$ | 11.7$ | **13.9$** | 5.3% |

## 6) الضمانات المُختبَرة

1. **لا حجز بلا دفع ناجح** — `finalizeBooking` يرفض `402` إن لم تكن الدفعة `succeeded`.
2. **idempotency** — نفس المفتاح = نفس الحجز (لا عمولة مزدوجة).
3. **آلة حالات صارمة** — `pending → confirmed → cancelled/refunded`، والعكس مرفوض `409`.
4. **السعر من الخادم** — كاش عروض 15 دقيقة؛ عرض مجهول ⇒ `409`.
5. **أمان Webhook** — توقيع HMAC + نافذة 300 ثانية (replay مرفوض).
6. **دفتر تدقيق** — `audit_events` + `timeline` لكل حجز + قيود `accrual/settle/reversal/payout`.

## 7) قبل الإنتاج — قائمة صريحة

- [ ] `DATABASE_URL` إلى Postgres مُدار + نسخ احتياطي + معاملات `SERIALIZABLE` عند الحاجة.
- [ ] `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + Stripe.js في الواجهة.
- [ ] للجزائر: مجمّع دفع محلي (SATIM/CIB/EDAHABIA) — محوّل بنفس الواجهة.
- [ ] طابور مهام (Queue) للحجز والتحويلات + Webhooks من المزوّدين بدل التنفيذ المتزامن.
- [ ] KYC للشركاء (وثائق + حدود سحب) — `MARIA_AUTO_APPROVE=false`.
- [ ] سجل موافقة العميل على رسوم 3% (نص + طابع زمني) — مطلب قانوني وتجاري.
- [ ] عقود المزوّدين: LiteAPI/Booking (فنادق)، Distribusion (قطارات)، Rentalcars (سيارات)، Expedia (بواخر/منازل).

## التحصيل في الحساب البريدي (CCP)

```bash
# 1) سجّل حسابك البريدي (مرة واحدة)
curl -X POST localhost:4173/api/payouts/account -H "Authorization: Bearer dev-admin-token" \
  -H "content-type: application/json" \
  -d '{"ownerType":"platform","holderName":"الاسم واللقب","ccpNumber":"0012345678","ccpKey":"04","ccpAgency":"بسكرة"}'

# 2) تحويل عمولتك إلى CCP
curl -X POST localhost:4173/api/payouts/platform/run -H "Authorization: Bearer dev-admin-token"

# 3) بعد الحوالة البريدية: سجّل رقم الوصل
curl -X POST localhost:4173/api/payouts/<id>/confirm -H "Authorization: Bearer dev-admin-token" \
  -H "content-type: application/json" -d '{"reference":"CCP-BSK-0001"}'

# 4) كشف التحويلات
curl localhost:4173/api/payouts/statement.csv -H "Authorization: Bearer dev-admin-token" > ccp.csv
```
المتغيّرات: `MARIA_CCP_NUMBER`, `MARIA_CCP_KEY`, `MARIA_CCP_HOLDER`, `MARIA_CCP_AGENCY`, `PAYOUT_CHANNEL=ccp`, `DZD_PER_USD`.
