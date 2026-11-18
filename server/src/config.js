/**
 * ماريا — إعدادات نموذج 3%
 * كل الأرقام في مكان واحد: تغيير نموذج العمل = تغيير سطر واحد.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const MODEL = {
  /** رسوم ماريا على قيمة كل حجز (تُضاف على سعر المزوّد وتُعرض للعميل بشفافية) */
  feeRate: 0.03,
  /** حصة شريك التوزيع من رسوم الـ3% (الباقي للمنصة) */
  partnerCut: 0.50,
  /** عملة العرض الافتراضية */
  currency: 'USD',
  /** تكلفة Duffel لكل حجز طيران مؤكَّد (بالدولار) */
  duffelOrderFee: 3.0,
  /** 1% Managed Content على حجوزات Duffel (IATA المُدارة) */
  duffelManagedContent: 0.01,
  /** دورة التحويل للشركاء (أيام) */
  payoutCycleDays: 7,
  /** مدة صلاحية عرض السعر قبل إعادة التسعير (دقيقة) */
  offerTtlMinutes: 15,
};

/**
 * القطاعات: نسبة عمولة/هامش المزوّد + المحوّل المسؤول.
 * supplierRate = ما يدفعه المزوّد/ما تحتفظ به من هامش على قيمة الحجز.
 */
export const VERTICALS = {
  flight:   { name: 'طيران',        icon: '✈️', adapter: 'duffel', supplierRate: 0.045, mode: 'booking' },
  hotel:    { name: 'فنادق',        icon: '🏨', adapter: 'mock',   supplierRate: 0.120, mode: 'booking' },
  train:    { name: 'قطارات',       icon: '🚄', adapter: 'mock',   supplierRate: 0.070, mode: 'booking' },
  cruise:   { name: 'بواخر',        icon: '🛳️', adapter: 'mock',   supplierRate: 0.060, mode: 'booking' },
  car:      { name: 'كراء سيارات',  icon: '🚗', adapter: 'mock',   supplierRate: 0.140, mode: 'booking' },
  home:     { name: 'منازل وشقق',   icon: '🏡', adapter: 'mock',   supplierRate: 0.100, mode: 'booking' },
  activity: { name: 'أنشطة وترفيه', icon: '🎟️', adapter: 'viator', supplierRate: 0.080, mode: 'handoff' },
  transfer: { name: 'توصيل ونقل',   icon: '🚐', adapter: 'mock',   supplierRate: 0.120, mode: 'booking' },
  health:   { name: 'صحة ومواعيد',  icon: '🩺', adapter: 'mock',   supplierRate: 0.150, mode: 'booking' },
};

export const ENV = {
  /** mock = بيانات نموذجية كاملة تعمل بلا مفاتيح | live = نداء المزوّدين الحقيقيين */
  mode: process.env.MARIA_MODE || 'mock',
  /* طريقة الحجز: request = العميل يطلب ونؤكّد · instant = تأكيد ودفع فوري */
  bookingMode: process.env.BOOKING_MODE || 'request',
  requestTtlHours: Number(process.env.REQUEST_TTL_HOURS || 48),
  adminEmail: process.env.ADMIN_EMAIL || null,
  port: Number(process.env.PORT || 4173),
  duffelKey: process.env.DUFFEL_API_KEY || '',
  duffelVersion: process.env.DUFFEL_VERSION || 'v2',
  duffelBaseUrl: process.env.DUFFEL_BASE_URL || 'https://api.duffel.com',
  viatorKey: process.env.VIATOR_API_KEY || '',
  viatorBaseUrl: process.env.VIATOR_BASE_URL || 'https://api.viator.com/partner',
  /** كود الشريك الذي يديره صاحب المنصة (أنت) */
  platformCode: process.env.MARIA_PLATFORM_CODE || 'MARIA',
  /** قاعدة البيانات: DATABASE_URL (Postgres) أو PGlite محلي */
  databaseUrl: process.env.DATABASE_URL || '',
  pgliteDir: process.env.PGLITE_DIR || path.join(ROOT, 'data', 'pglite'),
  /** المدفوعات */
  paymentProvider: process.env.PAYMENT_PROVIDER || 'sandbox', // sandbox|stripe|chargily|none
  stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  /** Chargily (الجزائر: CIB/EDAHABIA) */
  chargilyKey: process.env.CHARGILY_SECRET_KEY || '',
  chargilyWebhookSecret: process.env.CHARGILY_WEBHOOK_SECRET || '',
  chargilyTest: (process.env.CHARGILY_TEST ?? 'true') === 'true',
  /** من يتحمّل رسوم Chargily: merchant (نحن) | customer | split */
  chargilyFeesAllocation: process.env.CHARGILY_FEES_ALLOCATION || 'merchant',
  /** القناة المفضّلة: edahabia | cib | chargily_app */
  chargilyMethod: process.env.CHARGILY_METHOD || 'edahabia',
  dzdPerUsd: Number(process.env.DZD_PER_USD || 135),
  /** رمز إدارة لوحة التشغيل */
  adminToken: process.env.MARIA_ADMIN_TOKEN || 'dev-admin-token',
  /** تفعيل الشريك تلقائيًا (في الإنتاج: false + مراجعة KYC) */
  autoApprovePartners: (process.env.MARIA_AUTO_APPROVE ?? 'true') === 'true',
  /** الحساب البريدي (CCP) الذي تُحوَّل إليه عمولة المنصة */
  ccpNumber: (process.env.MARIA_CCP_NUMBER || '').replace(/\s+/g, ''),
  ccpKey: (process.env.MARIA_CCP_KEY || '').replace(/\s+/g, ''),
  ccpHolder: process.env.MARIA_CCP_HOLDER || '',
  ccpAgency: process.env.MARIA_CCP_AGENCY || '',
  /** قناة التحصيل الافتراضية للتحويلات */
  payoutChannel: process.env.PAYOUT_CHANNEL || 'ccp',   // ccp | bank | payoneer
  /** يُضبط صراحة في الإنتاج. إن تُرك فارغًا، يُستنتج من ترويسات الطلب (أنفاق/نطاق مؤقت). */
  /** البريد: console (تطوير) | resend | brevo | off */
  mailProvider: process.env.MAIL_PROVIDER || 'console',
  mailApiKey: process.env.MAIL_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'Maria <no-reply@maria.local>',
  mailReplyTo: process.env.MAIL_REPLY_TO || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  /** يُستنتج تلقائيًا من الطلب عند غياب PUBLIC_BASE_URL */
  publicBaseUrlAuto: '' ,
};

/**
 * الهوية القانونية للمنصة — تُطبع على كل فاتورة.
 * تُضبط من البيئة فقط (`.env`) — لا تُكتب في الكود ولا في Git.
 */
export const LEGAL = {
  name: process.env.MARIA_LEGAL_NAME || 'مؤسسة ماريا للخدمات الرقمية',
  rc: process.env.MARIA_RC_NUMBER || '',            // رقم السجل التجاري
  nif: process.env.MARIA_NIF || '',                 // رقم التعريف الجبائي
  ai: process.env.MARIA_AI || '',                   // رقم المادة الجبائية
  address: process.env.MARIA_LEGAL_ADDRESS || '',
  phone: process.env.MARIA_LEGAL_PHONE || '',
  email: process.env.MARIA_LEGAL_EMAIL || '',
  /** هل المؤسسة مرتّبية على الرسم على القيمة المضافة؟ (يغيّر شكل الفاتورة) */
  vatRegistered: (process.env.MARIA_VAT ?? 'false') === 'true',
  vatRate: Number(process.env.MARIA_VAT_RATE || 19) / 100,
  /** جاهزية الفوترة: وجود السجل التجاري + التعريف الجبائي */
  ready: Boolean(process.env.MARIA_RC_NUMBER && process.env.MARIA_NIF),
};

export const hasDuffel = () => ENV.mode === 'live' && Boolean(ENV.duffelKey);
export const hasViator = () => ENV.mode === 'live' && Boolean(ENV.viatorKey);
