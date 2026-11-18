/**
 * ماريا — خادم الحجز والعمولات v2
 * Postgres (PGlite/pg) + مدفوعات (sandbox/Stripe) + تسجيل شركاء ذاتي + نموذج 3%
 *
 * التشغيل: npm start        (npm install أول مرة)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ENV, MODEL, VERTICALS, ROOT } from './config.js';
import { initDb, dbInfo } from './db/index.js';
import * as repo from './db/repo.js';
import * as core from './ledger.js';
import { quote } from './pricing.js';
import { pay, paymentInfo } from './payments/index.js';
import * as stripe from './payments/stripe.js';
import * as chargily from './payments/chargily.js';
import * as invoice from './invoice.js';
import * as notify from './notify.js';
import * as requests from './requests.js';

/* ---------------- أدوات ---------------- */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,authorization,idempotency-key,stripe-signature',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const readRaw = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});
const readBody = async (req) => {
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON غير صالح'); }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
const sendFile = (res, file) => {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'غير موجود' });
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
};

/* ---------------- تهيئة قاعدة البيانات + بذور ---------------- */
export async function bootstrap() {
  await initDb();
  const partners = await repo.listPartners();
  if (!partners.length) {
    const seeds = [
      { code: ENV.platformCode, name: 'ماريا — البيع المباشر', type: 'platform', email: 'sales@maria.app' },
      /* حساب التحصيل البريدي يُسجَّل من MARIA_CCP_* عند الإقلاع (إن وُجد) */
      { code: 'AGENCY-DZ', name: 'وكالة أفق للسفر — الجزائر', type: 'agency', email: 'afaq@example.com' },
      { code: 'KIOSK-ALG', name: 'كشك مطار هواري بومدين', type: 'kiosk', email: 'kiosk@example.com' },
    ];
    for (const s of seeds) {
      await repo.createPartner({ ...s, status: 'active', country: 'DZ', apiKey: 'mrn_seed_' + s.code.toLowerCase().replace(/[^a-z0-9]/g, '') });
    }
  }
}

/* ---------------- الخادم ---------------- */
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return json(res, 204, {});

    try {
      /* ================= Webhooks (raw body) ================= */
      if (p === '/webhooks/stripe' && req.method === 'POST') {
        const raw = await readRaw(req);
        const sig = req.headers['stripe-signature'];
        const check = stripe.verifyWebhook(raw, sig);
        let event = {};
        try { event = JSON.parse(raw); } catch { /* ignore */ }

        if (!check.ok) {
          await repo.addWebhook({ provider: 'stripe', type: event?.type, verified: false, payload: event });
          return json(res, 400, { error: 'توقيع غير صالح', reason: check.reason });
        }
        const result = await core.handleStripeEvent(event, { verified: true });
        return json(res, 200, { received: true, ...result });
      }

      if (p === '/webhooks/chargily' && req.method === 'POST') {
        const raw = await readRaw(req);
        const check = chargily.verifyWebhook(raw, req.headers.signature);
        let event = {};
        try { event = JSON.parse(raw); } catch { /* ignore */ }
        if (!check.ok) {
          await repo.addWebhook({ provider: 'chargily', type: event?.type, verified: false, payload: event });
          return json(res, 400, { error: 'توقيع غير صالح', reason: check.reason });
        }
        return json(res, 200, { received: true, ...(await core.handleChargilyEvent(event, { verified: true })) });
      }

      /* ---------- صفحات عودة Chargily ---------- */
      if ((p === '/pay/success' || p === '/pay/failure') && req.method === 'GET') {
        const bookingId = url.searchParams.get('booking') || '';
        const checkoutId = url.searchParams.get('checkout_id') || url.searchParams.get('id') || '';
        let result = null;
        if (p === '/pay/success' && checkoutId) {
          result = await core.confirmFromCheckout(checkoutId).catch(e => ({ ok: false, reason: e.message }));
        }
        const okPage = p === '/pay/success' && (!result || result.ok !== false);
        const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${okPage ? 'تم الدفع' : 'لم يكتمل الدفع'} — ماريا</title>
<style>body{font-family:"Segoe UI",Tahoma,sans-serif;background:#0b1120;color:#eaf0ff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{max-width:460px;background:linear-gradient(160deg,rgba(57,230,195,.14),rgba(123,108,255,.16));border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:30px;text-align:center}
.ico{font-size:44px;margin-bottom:10px}h1{font-size:19px;margin:0 0 8px}p{font-size:13px;color:#aab6cc;line-height:1.9;margin:0 0 18px}
a{display:inline-block;background:linear-gradient(135deg,#39e6c3,#6d8bff);color:#04121a;font-weight:900;text-decoration:none;padding:11px 20px;border-radius:12px;font-size:13px}
code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px;font-size:11.5px}</style></head><body>
<div class="card"><div class="ico">${okPage ? '✅' : '⚠️'}</div>
<h1>${okPage ? 'تم استلام الدفع بنجاح' : 'لم يكتمل الدفع'}</h1>
<p>${okPage
  ? 'تم تأكيد حجزك، وستصلك الفاتورة وخطاب التأكيد على بريدك.'
  : 'لم نستلم تأكيد الدفع. إن خُصم المبلغ من حسابك فسيُعاد تلقائيًا، أو تواصل معنا وسنتحقّق فورًا.'}
</p>
${bookingId ? `<p>رقم الحجز: <code>${bookingId}</code></p>` : ''}
${result && result.ok === false && result.reason ? `<p style="font-size:11.5px">الحالة: ${result.reason}</p>` : ''}
<a href="/">العودة إلى ماريا</a></div></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      /* ================= API ================= */
      /* — نطاق تلقائي: إن لم يُضبط PUBLIC_BASE_URL نستنتجه من الطلب (يعمل مع الأنفاق) — */
      if (!ENV.publicBaseUrl) {
        const proto = (req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + ENV.port)).toString().split(',')[0].trim();
        ENV.publicBaseUrlAuto = `${proto}://${host}`;
        ENV.publicBaseUrl = ENV.publicBaseUrlAuto;
      }

      if (p === '/api/health') {
        return json(res, 200, {
          ok: true, app: 'ماريا Booking Engine v2', mode: ENV.mode, db: dbInfo(), payments: paymentInfo(),
          model: { feeRate: MODEL.feeRate, partnerCut: MODEL.partnerCut, currency: MODEL.currency },
          adapters: { duffel: ENV.duffelKey ? 'key set' : 'mock', viator: ENV.viatorKey ? 'key set' : 'mock' },
          time: new Date().toISOString(),
        });
      }

      if (p === '/api/ready') {
        try {
          await repo.listPartners();
          return json(res, 200, { ready: true, db: dbInfo().kind });
        } catch (e) {
          return json(res, 503, { ready: false, error: e.message });
        }
      }

      if (p === '/api/model') {
        return json(res, 200, {
          model: MODEL, verticals: VERTICALS,
          explanation: {
            fee: 'رسوم ماريا 3% على قيمة كل حجز — يدفعها العميل بشفافية',
            partner: 'الشريك يحصل على 50% من الـ3% (=1.5% من قيمة الحجز)',
            supplier: 'إضافة إلى عمولة/هامش المزوّد في القطاعات التي تدفعها',
            flow: 'بحث → نية دفع → تحقّق → حجز المزوّد → تأكيد → قيد → تحويل',
          },
        });
      }

      if (p === '/api/search' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, await core.search({ vertical: b.vertical, ref: b.ref || url.searchParams.get('ref'), params: b.params || b }));
      }

      if (p === '/api/quote' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, quote({ vertical: b.vertical, price: Number(b.price), ref: b.ref || null }));
      }

      /* ---------- الحجوزات ---------- */
      /* ══════════ طلبات الحجز (العميل يطلب، ونحن نؤكّد) ══════════ */
      if (p === '/api/requests' && req.method === 'POST') {
        const b = await readBody(req);
        const out = await requests.createRequest({
          offerId: b.offerId,
          customer: b.customer || {},
          note: b.note || null,
          passengers: b.passengers || null,
          ref: b.ref || url.searchParams.get('ref') || null,
        });
        return json(res, 201, { request: out, mode: ENV.bookingMode });
      }

      if (p === '/api/requests' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        if (url.searchParams.get('expire') === '1') await requests.expireStale();
        const [list, sum] = await Promise.all([
          requests.listRequests({ status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 100) }),
          requests.summary(),
        ]);
        return json(res, 200, { ...sum, requests: list });
      }

      /* حالة طلب عام (بلا بيانات شخصية) */
      const rqGet = p.match(/^\/api\/requests\/([A-Za-z0-9-]+)$/);
      if (rqGet && req.method === 'GET') {
        const found = await requests.getByCode(rqGet[1]);
        if (!found) return json(res, 404, { error: 'رقم طلب غير صحيح' });
        return json(res, 200, { request: found });
      }

      /* إلغاء من العميل */
      const rqCancel = p.match(/^\/api\/requests\/([A-Za-z0-9-]+)\/cancel$/);
      if (rqCancel && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { request: await requests.cancelRequest(rqCancel[1], { email: b.email }) });
      }

      const rqDecision = p.match(/^\/api\/requests\/([A-Za-z0-9-]+)\/(approve|reject)$/);
      if (rqDecision && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const b = await readBody(req);
        if (rqDecision[2] === 'approve') {
          const out = await requests.approveRequest(rqDecision[1], {
            adminNote: b.adminNote || null, method: b.method || 'card', passengers: b.passengers || null,
          });
          return json(res, 200, out);
        }
        return json(res, 200, { request: await requests.rejectRequest(rqDecision[1], { reason: b.reason }) });
      }

      if (p === '/api/bookings' && req.method === 'POST') {
        const b = await readBody(req);
        const out = await core.createBooking({
          offerId: b.offerId,
          ref: b.ref || url.searchParams.get('ref') || null,
          customer: b.customer || {},
          idempotencyKey: b.idempotencyKey || req.headers['idempotency-key'] || null,
          method: b.method || 'card',
        });
        return json(res, out.replayed ? 200 : 201, out);
      }

      if (p === '/api/bookings' && req.method === 'GET') {
        const rows = await repo.listBookings({
          partnerCode: url.searchParams.get('partner'),
          status: url.searchParams.get('status'),
          vertical: url.searchParams.get('vertical'),
          limit: url.searchParams.get('limit') || 100,
        });
        return json(res, 200, { bookings: rows });
      }

      const stMatch = p.match(/^\/api\/bookings\/([^/]+)\/status$/);
      if (stMatch && ['POST', 'PATCH'].includes(req.method)) {
        const b = await readBody(req);
        const booking = b.status === 'cancelled'
          ? await core.cancelBooking(stMatch[1], b.reason || 'إلغاء')
          : await core.setStatus(stMatch[1], b.status, b.reason || null);
        return json(res, 200, { booking });
      }

      const recMatch = p.match(/^\/api\/bookings\/([^/]+)\/reconcile$/);
      if (recMatch && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const b = await readBody(req);
        const booking = await core.reconcileBooking(recMatch[1], { commission: b.commission, note: b.note });
        return json(res, 200, { booking });
      }

      /* عرض دفع عام للعميل (بلا بيانات داخلية) */
      const payView = p.match(/^\/api\/pay\/([^/]+)$/);
      if (payView && req.method === 'GET') {
        const b = await repo.getBooking(payView[1]);
        if (!b) return json(res, 404, { error: 'حجز غير موجود' });
        const pm = await repo.getPaymentByBooking(b.id);
        const v = VERTICALS[b.vertical] || {};
        return json(res, 200, {
          bookingId: b.id,
          status: b.status,
          vertical: b.vertical, verticalName: v.name || b.vertical, icon: v.icon || '🎫',
          offer: { title: b.offer?.title, subtitle: b.offer?.subtitle },
          customer: { name: b.customer?.name || '' },
          pricing: { basePrice: b.pricing?.basePrice, platformFee: b.pricing?.platformFee, customerTotal: b.pricing?.customerTotal, currency: b.pricing?.currency },
          payment: pm ? {
            id: pm.id, amount: pm.amount, currency: pm.currency, status: pm.status,
            provider: pm.provider, method: pm.method,
            paid: pm.status === 'succeeded',
          } : null,
        });
      }

      /* ---------- المدفوعات ---------- */
      const payMatch = p.match(/^\/api\/payments\/([^/]+)\/confirm$/);
      if (payMatch && req.method === 'POST') {
        const b = await readBody(req);
        const out = await core.confirmPayment(payMatch[1], {
          threeDS: b.threeDS || 'success', cardLast4: b.cardLast4 || null, passengers: b.passengers || [],
        });
        return json(res, out.ok ? 200 : 402, out);
      }

      if (p === '/api/payments' && req.method === 'GET') {
        const rows = await repo.getPaymentByBooking(url.searchParams.get('bookingId'));
        return json(res, rows ? 200 : 404, rows || { error: 'لا دفعة' });
      }

      /* ---------- الشركاء: تسجيل ذاتي ---------- */
      if (p === '/api/partners/apply' && req.method === 'POST') {
        const b = await readBody(req);
        const out = await core.applyPartner({
          name: b.name, type: b.type, email: b.email, phone: b.phone, country: b.country,
          payoutMethod: b.payoutMethod, autoApprove: Boolean(ENV.autoApprovePartners),
        });
        /* بريد ترحيب بالشريك (لا يُفشل التسجيل) */
        notify.notifyPartnerWelcome({ ...out.partner, email: b.email }, out.referralLink).catch(() => {});
        return json(res, 201, out);
      }

      const apMatch = p.match(/^\/api\/partners\/([^/]+)\/approve$/);
      if (apMatch && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const partner = await core.approvePartner(apMatch[1]);
        return json(res, 200, { partner: { code: partner.code, status: partner.status } });
      }

      if (p === '/api/partner/login' && req.method === 'POST') {
        const b = await readBody(req);
        const partner = await repo.getPartner(b.code);
        if (!partner || (partner.email && b.email && partner.email.toLowerCase() !== String(b.email).toLowerCase())) {
          return json(res, 401, { error: 'بيانات غير صحيحة' });
        }
        return json(res, 200, { token: partner.api_key, code: partner.code, name: partner.name, status: partner.status });
      }

      if (p === '/api/partner/me' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const partner = await repo.getPartnerByApiKey(token);
        if (!partner) return json(res, 401, { error: 'مفتاح غير صالح' });
        return json(res, 200, await core.partnerSummary(partner.code));
      }

      if (p === '/api/partners' && req.method === 'GET') {
        const partners = await repo.listPartners();
        const out = [];
        for (const pt of partners) out.push(await core.partnerSummary(pt.code));
        return json(res, 200, { partners: out });
      }

      if (p === '/api/partners' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const b = await readBody(req);
        const out = await core.applyPartner({ name: b.name, type: b.type, email: b.email || 'admin@maria.app', country: b.country, autoApprove: true });
        return json(res, 201, out);
      }

      const psMatch = p.match(/^\/api\/partners\/([^/]+)\/summary$/);
      if (psMatch && req.method === 'GET') return json(res, 200, await core.partnerSummary(decodeURIComponent(psMatch[1])));

      /* ---------- الملخّص والتحويلات ---------- */
      if (p === '/api/summary') {
        const sum = await core.platformSummary();
        return json(res, 200, { ...sum, adminRequired: true });
      }

      if (p === '/api/payouts/run' && req.method === 'POST') {
        const b = await readBody(req);
        const payouts = await core.runPayouts({ partnerCode: b.partnerCode || null, force: b.force !== false });
        return json(res, 200, { payouts, count: payouts.length });
      }

      /* ---------- صندوق الرسائل (Outbox) ---------- */
      if (p === '/api/outbox' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        return json(res, 200, await notify.outboxSummary(Number(url.searchParams.get('limit') || 50)));
      }

      const obResend = p.match(/^\/api\/outbox\/([^/]+)\/resend$/);
      if (obResend && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const rec = await notify.resend(obResend[1]);
        return json(res, 200, { message: { id: rec.id, status: rec.status, provider: rec.provider, error: rec.error, attempts: rec.attempts } });
      }

      const obView = p.match(/^\/outbox\/([^/]+)$/);
      if (obView && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        if (t !== ENV.adminToken) return json(res, 401, { error: 'رابط غير صالح' });
        const rec = await repo.getOutbox(obView[1]);
        if (!rec) return json(res, 404, { error: 'رسالة غير موجودة' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(rec.html || '<pre>' + (rec.text || '') + '</pre>');
      }

      /* ---------- الفوترة (RC + NIF) ---------- */
      if (p === '/api/legal' && req.method === 'GET') {
        return json(res, 200, { legal: invoice.legalState() });
      }

      const invIssue = p.match(/^\/api\/bookings\/([^/]+)\/invoice$/);
      if (invIssue && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const out = await invoice.issueInvoice(invIssue[1]);
        return json(res, out.replayed ? 200 : 201, { invoice: out.invoice, replayed: out.replayed });
      }

      if (p === '/api/invoices' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const rows = await repo.listInvoices(Number(url.searchParams.get('limit') || 100));
        return json(res, 200, { invoices: rows });
      }

      const invGet = p.match(/^\/api\/invoices\/([^/]+)$/);
      if (invGet && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const inv = await repo.getInvoiceByNumber(decodeURIComponent(invGet[1]));
        return json(res, inv ? 200 : 404, inv ? { invoice: inv } : { error: 'فاتورة غير موجودة' });
      }

      /* فاتورة قابلة للطباعة (تُفتح في المتصفح برمز في الرابط) */
      const invPage = p.match(/^\/invoice\/([^/]+)$/);
      if (invPage && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        if (t !== ENV.adminToken) return json(res, 401, { error: 'رابط غير صالح' });
        const inv = await repo.getInvoiceByNumber(decodeURIComponent(invPage[1]));
        if (!inv) return json(res, 404, { error: 'فاتورة غير موجودة' });
        const html = invoice.invoiceHtml(inv);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
        return res.end(html);
      }

      /* ---------- حساب التحصيل البريدي (CCP) ---------- */

      /* الشريك يسجّل حسابه: مفتاح الشريك أو رمز الإدارة */
      if (p === '/api/payouts/account' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const b = await readBody(req);
        let ownerType = b.ownerType === 'platform' ? 'platform' : 'partner';
        let ownerCode = b.ownerCode || null;

        if (token === ENV.adminToken) {
          ownerCode = ownerType === 'platform' ? ENV.platformCode : ownerCode;
        } else {
          const partner = await repo.getPartnerByApiKey(token);
          if (!partner) return json(res, 401, { error: 'مفتاح غير صالح' });
          ownerType = 'partner';
          ownerCode = partner.code;
        }
        if (!ownerCode) return json(res, 400, { error: 'ownerCode مطلوب' });

        const account = await core.setPayoutAccount({
          ownerType, ownerCode,
          method: b.method || 'ccp',
          holderName: b.holderName, ccpNumber: b.ccpNumber, ccpKey: b.ccpKey,
          ccpAgency: b.ccpAgency, bankRib: b.bankRib, foreignWallet: b.foreignWallet,
          verified: token === ENV.adminToken ? Boolean(b.verified) : false,
        });
        return json(res, 200, { account });
      }

      /* حسابي: المنصة (إدارة) أو الشريك (مفتاحه) */
      if (p === '/api/payouts/account' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token === ENV.adminToken) {
          const report = await core.platformPayoutReport();
          return json(res, 200, { account: report.destination, report });
        }
        const partner = await repo.getPartnerByApiKey(token);
        if (!partner) return json(res, 401, { error: 'مفتاح غير صالح' });
        const dest = await core.getDestination('partner', partner.code);
        const sum = await core.partnerSummary(partner.code);
        return json(res, 200, {
          account: dest,
          report: {
            available: sum.partnerUnpaid,
            availableDzd: Math.round(sum.partnerUnpaid * ENV.dzdPerUsd * 100) / 100,
            rate: ENV.dzdPerUsd,
            blocked: dest ? null : 'أضف رقم حسابك البريدي ومفتاحه لاستلام عمولاتك',
          },
        });
      }

      /* تحويلات الشريك (بوابته) */
      if (p === '/api/partner/payouts' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const partner = await repo.getPartnerByApiKey(token);
        if (!partner) return json(res, 401, { error: 'مفتاح غير صالح' });
        const all = await core.payoutStatement({ ownerType: 'partner', limit: 200 });
        return json(res, 200, { payouts: all.filter(x => x.code === partner.code) });
      }

      /* تقرير عمولة المنصة القابلة للتحويل إلى CCP */
      if (p === '/api/payouts/platform' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        return json(res, 200, await core.platformPayoutReport());
      }

      /* إنشاء تحويل عمولة المنصة إلى الحساب البريدي */
      if (p === '/api/payouts/platform/run' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const out = await core.runPlatformPayout({ idempotent: true });
        return json(res, out.payout ? 201 : 200, out);
      }

      /* تسجيل وصل الحوالة البريدية ⇒ مُنفَّذ */
      const pconfMatch = p.match(/^\/api\/payouts\/([^/]+)\/confirm$/);
      if (pconfMatch && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const b = await readBody(req);
        const payout = await core.confirmPayout(pconfMatch[1], { reference: b.reference, executedAt: b.executedAt });
        return json(res, 200, {
          payout: {
            id: payout.id, status: payout.status, reference: payout.reference,
            amount: Number(payout.amount), amountDzd: Number(payout.amount_dzd),
            destination: payout.destination, executedAt: payout.executed_at,
          },
        });
      }

      /* كشف التحويلات CSV (يُفتح في Excel) */
      if (p === '/api/payouts/statement.csv') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (token !== ENV.adminToken) return json(res, 401, { error: 'يتطلب رمز إدارة' });
        const rows = await core.payoutStatement({ ownerType: url.searchParams.get('owner'), limit: 500 });
        const head = 'id,owner,amount_usd,rate,amount_dzd,destination,status,reference,executed_at,bookings';
        const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const csv = '\uFEFF' + [head, ...rows.map(r => [
          r.id, r.owner, r.amountUsd, r.rate, r.amountDzd, r.destination, r.status, r.reference, r.executedAt || '', r.bookings,
        ].map(cell).join(','))].join('\n');
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="ccp-payouts.csv"' });
        return res.end(csv);
      }

      /* ---------- تجارب ---------- */
      if (p === '/api/demo/booking' && req.method === 'POST') {
        const b = await readBody(req);
        const verticals = Object.keys(VERTICALS);
        const vertical = b.vertical && VERTICALS[b.vertical] ? b.vertical : verticals[Math.floor(Math.random() * verticals.length)];
        const partners = (await repo.listPartners()).filter(x => x.status === 'active');
        if (!partners.length) return json(res, 400, { error: 'لا شركاء مُفعّلين' });
        const ref = b.ref || partners[Math.floor(Math.random() * partners.length)].code;
        const found = await core.search({ vertical, ref });
        if (!found.offers.length) return json(res, 400, { error: 'لا عروض' });
        const offer = found.offers[Math.floor(Math.random() * found.offers.length)];
        const { booking, payment } = await core.createBooking({ offerId: offer.id, ref, customer: { name: 'عميل تجريبي' } });
        const out = await core.confirmPayment(payment.id, { threeDS: 'success' });
        return json(res, 201, out);
      }

      if (p === '/api/demo/seed' && req.method === 'POST') {
        const b = await readBody(req);
        const n = Math.min(Number(b.count || 10), 60);
        const verticals = Object.keys(VERTICALS);
        const partners = await repo.listPartners();
        let created = 0;
        for (let i = 0; i < n; i++) {
          try {
            const vertical = verticals[Math.floor(Math.random() * verticals.length)];
            const ref = partners[Math.floor(Math.random() * partners.length)].code;
            const found = await core.search({ vertical, ref });
            if (!found.offers.length) continue;
            const offer = found.offers[Math.floor(Math.random() * Math.min(3, found.offers.length))];
            const { booking, payment, affiliate } = await core.createBooking({ offerId: offer.id, ref });

            /* وضع الإحالة: تُثبَّت العمولة من التقرير لاحقًا — هنا نحاكي وصوله */
            if (affiliate) {
              if (Math.random() < 0.85) {
                await core.reconcileBooking(booking.id, { commission: booking.pricing.supplierCommission, note: 'تقرير المزوّد (محاكاة)' });
                created++;
              }
              continue;
            }

            if (Math.random() < 0.12) {
              /* محاكاة فشل دفع */
              await core.confirmPayment(payment.id, { threeDS: 'fail' });
              continue;
            }
            await core.confirmPayment(payment.id, { threeDS: 'success' });
            if (Math.random() < 0.1) await core.cancelBooking(booking.id, 'اختبار استرداد').catch(() => {});
            created++;
          } catch (e) {
            await repo.addAudit('seed.error', { message: String(e.message || e) });
          }
        }
        return json(res, 201, { created });
      }

      /* ---------- الصفحات ---------- */
      if (p === '/' || p === '/book') return sendFile(res, path.join(ROOT, '..', 'book', 'index.html'));
      if (p === '/dashboard' || p === '/admin') return sendFile(res, path.join(ROOT, 'public', 'dashboard.html'));
      if (p === '/join') return sendFile(res, path.join(ROOT, 'public', 'join.html'));
      if (p === '/partner') return sendFile(res, path.join(ROOT, 'public', 'partner.html'));
      if (p === '/request') return sendFile(res, path.join(ROOT, 'public', 'request.html'));
      if (p === '/pay') return sendFile(res, path.join(ROOT, 'public', 'pay.html'));
      if (p === '/landing') return sendFile(res, path.join(ROOT, '..', 'index.html'));
      if (p.startsWith('/public/')) return sendFile(res, path.join(ROOT, decodeURIComponent(p)));
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

      return json(res, 404, { error: 'مسار غير معروف', path: p });
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message || 'خطأ غير متوقع' });
    }
  });
}

/* ---------------- تشغيل ---------------- */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  await bootstrap();
  const server = createServer();

  /* إيقاف لطيف (Docker/systemd): إغلاق الاستقبال ثم الخروج */
  const shutdown = (signal) => {
    console.log(`\n[${signal}] إيقاف لطيف…`);
    server.close(() => { console.log('أُغلق الخادم'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(ENV.port, '0.0.0.0', () => {
    console.log(`\n  ماريا — خادم الحجز v2`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  الوضع       : ${ENV.mode}`);
    console.log(`  قاعدة البيانات: ${dbInfo().kind}`);
    console.log(`  المدفوعات   : ${paymentInfo().provider}`);
    console.log(`  الحجز       : http://localhost:${ENV.port}/`);
    console.log(`  لوحة الشركاء: http://localhost:${ENV.port}/dashboard`);
    console.log(`  تسجيل شريك  : http://localhost:${ENV.port}/join`);
    console.log(`  بوابة شريك  : http://localhost:${ENV.port}/partner`);
    console.log(`  النموذج     : رسوم ${MODEL.feeRate * 100}% · الشريك ${MODEL.partnerCut * 100}% من الرسوم\n`);
  });
}
