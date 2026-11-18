/**
 * ماريا — الإشعارات (Outbox + قوالب + ناقل بلا مكتبات خارجية)
 *
 * المبادئ:
 *  1. كل رسالة تُحفظ في قاعدة البيانات **قبل** الإرسال → لا يضيع أي إشعار.
 *  2. فشل البريد لا يُفشل الحجز أبدًا (fire-and-forget).
 *  3. الناقل قابل للتبديل: console (تطوير) · resend · brevo · off.
 *  4. لا نضع مفاتيح أو بيانات دفع في نص الرسالة.
 */
import { ENV, LEGAL, MODEL, VERTICALS } from './config.js';
import * as repo from './db/repo.js';

const money = (n, c = 'USD') =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n || 0)) +
  (c === 'DZD' ? ' دج' : ' $');

const base = () => ENV.publicBaseUrl || ENV.publicBaseUrlAuto || ('http://localhost:' + ENV.port);

export const mailerInfo = () => ({
  provider: ENV.mailProvider,
  from: ENV.mailFrom,
  live: Boolean(ENV.mailApiKey) && !['console', 'off'].includes(ENV.mailProvider),
  outbox: true,
});

/* ══════════════════════════ القوالب ══════════════════════════ */

function shell({ title, preheader = '', body }) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Tahoma,sans-serif;color:#0d1526">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#39e6c3,#6d8bff);border-radius:16px 16px 0 0;padding:22px 24px">
    <div style="font-size:20px;font-weight:900;color:#04121a">ماريا</div>
    <div style="font-size:11px;letter-spacing:1.5px;color:#04121a;opacity:.75;font-weight:700">MARIA — BOOKING &amp; TRAVEL</div>
  </div>
  <div style="background:#fff;border-radius:0 0 16px 16px;padding:26px 24px;border:1px solid #e6ebf3;border-top:0">
    ${body}
  </div>
  <div style="text-align:center;color:#8a95a8;font-size:11px;line-height:1.9;margin-top:16px">
    ${LEGAL.name}${LEGAL.rc ? ' · سجل تجاري ' + LEGAL.rc : ''}${LEGAL.nif ? ' · NIF ' + LEGAL.nif : ''}<br>
    ${preheader ? preheader + '<br>' : ''}
    هذه رسالة آلية — لا تُرسل ردًا إلى هذا العنوان.
  </div>
</div></body></html>`;
}

const row = (k, v) => `<tr><td style="padding:7px 0;color:#68738a;font-size:12.5px">${k}</td>
<td style="padding:7px 0;font-size:13.5px;font-weight:700;text-align:left">${v}</td></tr>`;

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:linear-gradient(135deg,#39e6c3,#6d8bff);color:#04121a;font-weight:900;text-decoration:none;padding:12px 22px;border-radius:12px;font-size:14px">${label}</a>`;

/** استلام طلب حجز — للعميل */
export function tplRequestReceived(r, { trackingUrl } = {}) {
  const v = VERTICALS[r.vertical];
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">استلمنا طلبك 📩</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">
      شكرًا ${r.customer?.name || ''} — طلبك مسجَّل الآن. نتحقّق من التوفّر والسعر النهائي،
      ونردّ عليك على هذا البريد خلال <b>${ENV.requestTtlHours || 48} ساعة</b> كحدّ أقصى.
      <b>لن تدفع أي شيء قبل موافقتنا.</b>
    </p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('رقم الطلب', '<span style="font-family:monospace;letter-spacing:1px">' + r.code + '</span>')}
      ${row('القطاع', (v?.icon || '') + ' ' + (v?.name || r.vertical))}
      ${row('الخدمة', r.offer?.title || '—')}
      ${row('المزوّد', r.offer?.subtitle || '—')}
      ${row('السعر التقديري', money(r.offer?.price, r.offer?.currency))}
    </table>
    <p style="font-size:12.5px;color:#5b6780;margin:16px 0 0">
      السعر تقديري وقد يتغيّر قليلًا حسب التوفّر. إن تغيّر سنخبرك قبل أي دفع.
    </p>
    ${trackingUrl ? `<div style="margin-top:20px;text-align:center">${btn(trackingUrl, 'تتبّع طلبك')}</div>` : ''}`;
  return {
    subject: `استلمنا طلبك ${r.code} — ماريا`,
    html: shell({ title: 'طلب حجز', body, preheader: 'طلبك مسجَّل — لا دفع قبل موافقتنا' }),
    text: `استلمنا طلب الحجز ${r.code}. سنردّ خلال ${ENV.requestTtlHours || 48} ساعة.`,
  };
}

/** موافقة على الطلب — للعميل، مع رابط الدفع */
export function tplRequestApproved(r, { booking, payUrl } = {}) {
  const v = VERTICALS[r.vertical];
  const b = booking || {};
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">طلبك جاهز — أكمل الدفع ✅</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">
      ${r.customer?.name || ''} — أكّدنا التوفّر واستقرّ السعر. حجزك محفوظ باسمك حتى تكمل الدفع.
    </p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('رقم الطلب', '<span style="font-family:monospace">' + r.code + '</span>')}
      ${row('القطاع', (v?.icon || '') + ' ' + (v?.name || r.vertical))}
      ${row('الخدمة', r.offer?.title || '—')}
      ${b.pricing ? row('سعر المزوّد', money(b.pricing.basePrice, b.pricing.currency)) : ''}
      ${b.pricing && Number(b.pricing.platformFee) > 0 ? row('رسوم الخدمة 3%', money(b.pricing.platformFee, b.pricing.currency)) : ''}
      ${b.pricing ? row('الإجمالي المطلوب', money(b.pricing.customerTotal, b.pricing.currency)) : ''}
    </table>
    ${r.adminNote ? `<div style="margin-top:14px;padding:11px 13px;background:#f4f7fc;border-radius:10px;font-size:12.5px;color:#3f4b63">📝 ${r.adminNote}</div>` : ''}
    ${payUrl ? `<div style="margin-top:22px;text-align:center">${btn(payUrl, 'ادفع الآن')}</div>` : ''}
    <p style="font-size:12px;color:#8a95a8;margin:16px 0 0;text-align:center">
      إن لم يعمل الزر: ${payUrl || base()}
    </p>`;
  return {
    subject: `طلبك ${r.code} جاهز للدفع — ماريا`,
    html: shell({ title: 'الموافقة على الطلب', body, preheader: 'أكّدنا التوفّر — أكمل الدفع' }),
    text: `طلبك ${r.code} جاهز. أكمل الدفع: ${payUrl || ''}`,
  };
}

/** رفض الطلب — للعميل، بصراحة */
export function tplRequestRejected(r, reason) {
  const v = VERTICALS[r.vertical];
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">لم نتمكّن من تأكيد طلبك</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">
      ${r.customer?.name || ''} — آسفون، لم نستطع تأكيد هذا الطلب.
      <b>لم تدفع أي مبلغ</b>، ولا يوجد أي التزام عليك.
    </p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('رقم الطلب', r.code)}
      ${row('القطاع', (v?.icon || '') + ' ' + (v?.name || r.vertical))}
      ${row('الخدمة', r.offer?.title || '—')}
      ${row('السبب', reason || r.adminNote || 'غير متوفّر حاليًا')}
    </table>
    <p style="font-size:13px;color:#3f4b63;margin:16px 0 0">
      أقترح عليك عرضًا آخر على نفس الخط أو تاريخًا قريبًا — أجب على هذه الرسالة وسنبحث بدلًا عنك.
    </p>
    <div style="margin-top:20px;text-align:center">${btn(base() + '/book', 'ابحث عن عرض آخر')}</div>`;
  return {
    subject: `بخصوص طلبك ${r.code} — ماريا`,
    html: shell({ title: 'تحديث الطلب', body, preheader: 'لم يُخصم منك أي مبلغ' }),
    text: `لم نتمكّن من تأكيد طلبك ${r.code}. لم تدفع أي مبلغ.`,
  };
}

/** تنبيه لك أنت (الإدارة) بطلب جديد */
export function tplAdminNewRequest(r, { dashboardUrl } = {}) {
  const v = VERTICALS[r.vertical];
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">📩 طلب حجز جديد — ${r.code}</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('العميل', `${r.customer?.name || ''} · ${r.customer?.phone || ''}`)}
      ${row('البريد', r.customer?.email || '—')}
      ${row('القطاع', (v?.icon || '') + ' ' + (v?.name || r.vertical))}
      ${row('الخدمة', r.offer?.title || '—')}
      ${row('المزوّد', r.offer?.subtitle || '—')}
      ${row('السعر', money(r.offer?.price, r.offer?.currency))}
      ${r.note ? row('ملاحظة العميل', r.note) : ''}
      ${r.ref ? row('المصدر', r.ref) : ''}
    </table>
    ${dashboardUrl ? `<div style="margin-top:20px;text-align:center">${btn(dashboardUrl, 'افتح لوحة الطلبات')}</div>` : ''}`;
  return {
    subject: `[طلب جديد] ${r.code} · ${v?.name || r.vertical} · ${r.customer?.name || ''}`,
    html: shell({ title: 'طلب جديد', body }),
    text: `طلب جديد ${r.code} من ${r.customer?.name} — ${r.offer?.title}`,
  };
}
/** تأكيد الحجز للعميل */
export function tplBookingConfirmed(b) {
  const v = VERTICALS[b.vertical];
  const link = base() + '/book?booking=' + b.id;
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">تم تأكيد حجزك ✅</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">شكرًا ${b.customer?.name || ''} — حجزك مؤكَّد لدينا.</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('رقم الحجز', String(b.id).slice(-10))}
      ${row('القطاع', (v?.icon || '') + ' ' + (v?.name || b.vertical))}
      ${row('الخدمة', b.offer?.title || '—')}
      ${row('سعر المزوّد', money(b.pricing?.basePrice, b.pricing?.currency))}
      ${Number(b.pricing?.platformFee) > 0 ? row('رسوم الخدمة 3%', money(b.pricing.platformFee, b.pricing.currency)) : ''}
      ${row('الإجمالي المدفوع', money(b.pricing?.customerTotal, b.pricing?.currency))}
    </table>
    <div style="margin-top:20px;text-align:center">${btn(link, 'عرض الحجز')}</div>`;
  return { subject: `تأكيد الحجز ${String(b.id).slice(-6)} — ماريا`, html: shell({ title: 'تأكيد الحجز', body }), text: `تم تأكيد حجزك ${b.id}. الإجمالي ${money(b.pricing?.customerTotal)}` };
}

/** حجز إحالة: العميل يكمل الدفع عند المزوّد */
export function tplBookingReferred(b) {
  const link = b.handoff_url || base();
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">احجز الآن عند المزوّد</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">
      سجّلنا طلبك، والدفع يتم مباشرة إلى الجهة المزوّدة. أكمل الحجز من الزر التالي:
    </p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('الطلب', String(b.id).slice(-10))}
      ${row('الخدمة', b.offer?.title || '—')}
      ${row('سعر المزوّد', money(b.pricing?.basePrice, b.pricing?.currency))}
    </table>
    <div style="margin-top:20px;text-align:center">${btn(link, 'إكمال الحجز عند المزوّد')}</div>`;
  return { subject: `أكمل حجزك — ${b.offer?.title?.slice(0, 40) || 'ماريا'}`, html: shell({ title: 'إكمال الحجز', body }), text: `أكمل حجزك من: ${link}` };
}

/** إشعار فاتورة */
export function tplInvoice(inv) {
  const link = base() + '/invoice/' + encodeURIComponent(inv.number) + '?t=' + encodeURIComponent(ENV.adminToken);
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">فاتورتك جاهزة 🧾</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">فاتورة رسمية بحسب القانون الجزائري (سجل تجاري + NIF).</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('رقم الفاتورة', inv.number)}
      ${row('التاريخ', new Date(inv.issued_at || Date.now()).toLocaleDateString('fr-DZ'))}
      ${row('الإجمالي', money(inv.total, inv.currency))}
      ${inv.total_dzd ? row('ما يعادله', money(inv.total_dzd, 'DZD')) : ''}
    </table>
    <div style="margin-top:20px;text-align:center">${btn(link, 'عرض الفاتورة / طباعة')}</div>
    <p style="font-size:11.5px;color:#8a95a8;margin-top:16px">الرابط خاص بك — لا تشاركه.</p>`;
  return { subject: `فاتورة ${inv.number} — ${LEGAL.name}`, html: shell({ title: 'الفاتورة', body }), text: `فاتورتك ${inv.number} بمبلغ ${inv.total} ${inv.currency}` };
}

/** إشعار تحويل للشريك */
export function tplPayoutSent(p, partnerName) {
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">تم تحويل مستحقاتك 💸</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">مرحبًا ${partnerName || ''} — حوّلنا حصتك من رسوم المنصة.</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('المبلغ', money(p.amount, 'USD'))}
      ${p.amount_dzd ? row('بالدينار', money(p.amount_dzd, 'DZD')) : ''}
      ${row('الوجهة', p.destination || '—')}
      ${row('رقم الحوالة', p.reference || '—')}
      ${row('عدد الحجوزات', String((p.items || []).length))}
    </table>`;
  return { subject: `تحويل مستحقاتك — ${money(p.amount, 'USD')}`, html: shell({ title: 'تحويل', body }), text: `حوّلنا ${p.amount}$ إلى حسابك. مرجع: ${p.reference || '-'}` };
}

/** ترحيب بشريك جديد */
export function tplPartnerWelcome(partner, referralLink) {
  const body = `
    <h2 style="font-size:17px;margin:0 0 6px">أهلًا بك في شبكة ماريا 🤝</h2>
    <p style="font-size:13.5px;color:#5b6780;margin:0 0 16px">حسابك جاهز: <b>${partner.code}</b></p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ebf3">
      ${row('حصتك', 'نصف رسوم الخدمة (1.5%)')}
      ${row('الدفع', 'يُحوَّل إلى حسابك البريدي CCP')}
    </table>
    <div style="margin-top:20px;text-align:center">${btn(referralLink, 'رابط الإحالة الخاص بك')}</div>`;
  return { subject: `مرحبًا في ماريا — ${partner.code}`, html: shell({ title: 'ترحيب', body }), text: `حسابك ${partner.code}. رابط الإحالة: ${referralLink}` };
}

/* ══════════════════════════ الإرسال ══════════════════════════ */

/** ينقل رسالة إلى الناقل الخارجي (بلا مكتبات) */
async function deliver(rec, { to, subject, html, text }) {
  const p = ENV.mailProvider;
  if (p === 'off') {
    return repo.markOutbox(rec.id, { status: 'failed', provider: 'off', error: 'MAIL_PROVIDER=off' });
  }
  if (p === 'console' || !ENV.mailApiKey) {
    console.log(`\n  ✉️  [outbox:console] → ${to}\n     ${subject}`);
    return repo.markOutbox(rec.id, { status: 'sent', provider: 'console', providerRef: 'console-' + rec.id, sentAt: new Date().toISOString() });
  }

  try {
    let url, headers, payload;
    if (p === 'resend') {
      url = 'https://api.resend.com/emails';
      headers = { Authorization: `Bearer ${ENV.mailApiKey}`, 'Content-Type': 'application/json' };
      payload = { from: ENV.mailFrom, to: [to], subject, html, text, reply_to: ENV.mailReplyTo || undefined };
    } else if (p === 'brevo') {
      url = 'https://api.brevo.com/v3/smtp/email';
      headers = { 'api-key': ENV.mailApiKey, 'Content-Type': 'application/json' };
      payload = { sender: { email: (ENV.mailFrom.match(/<(.+)>/) || [, ENV.mailFrom])[1], name: 'ماريا' }, to: [{ email: to }], subject, htmlContent: html, textContent: text };
    } else {
      throw new Error('مزوّد بريد غير مدعوم: ' + p);
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return repo.markOutbox(rec.id, { status: 'sent', provider: p, providerRef: body.id || body.messageId || null, sentAt: new Date().toISOString() });
  } catch (e) {
    return repo.markOutbox(rec.id, { status: 'failed', provider: p, error: String(e.message || e).slice(0, 300) });
  }
}

/**
 * إرسال موحّد: يحفظ ثم يرسل. لا يرمي استثناءًا أبدًا (كي لا يُفشل الحجز).
 */
export async function send({ to, subject, html, text, template = null, bookingId = null, ref = null }) {
  if (!to || !String(to).includes('@')) return null;
  try {
    const rec = await repo.addOutbox({ to, subject, html, text, template, bookingId, ref });
    return await deliver(rec, { to, subject, html, text });
  } catch (e) {
    console.error('notify.send:', e.message);
    return null;
  }
}

/** إعادة إرسال رسالة من الصندوق */
export async function resend(id) {
  const rec = await repo.getOutbox(id);
  if (!rec) throw Object.assign(new Error('رسالة غير موجودة'), { statusCode: 404 });
  return deliver(rec, { to: rec.to_addr, subject: rec.subject, html: rec.html, text: rec.text });
}

/* ══════════ ربط الإشعارات بمنطق المنصة (كلها fire-and-forget) ══════════ */

export async function notifyBooking(booking) {
  const c = booking.customer || {};
  if (!c.email) return null;
  const tpl = booking.status === 'referred' ? tplBookingReferred(booking) : tplBookingConfirmed(booking);
  return send({ to: c.email, ...tpl, template: `booking.${booking.status}`, bookingId: booking.id, ref: booking.ref });
}

export async function notifyInvoice(inv, customerEmail) {
  if (!customerEmail) return null;
  return send({ to: customerEmail, ...tplInvoice(inv), template: 'invoice.issued', bookingId: inv.booking_id });
}

export async function notifyPayout(p, partnerName) {
  const partner = await repo.getPartner(p.partner_code).catch(() => null);
  if (!partner?.email) return null;
  return send({ to: partner.email, ...tplPayoutSent(p, partnerName || partner.name), template: 'payout.sent', ref: p.partner_code });
}

export async function notifyPartnerWelcome(partner, referralLink) {
  if (!partner?.email) return null;
  return send({ to: partner.email, ...tplPartnerWelcome(partner, referralLink), template: 'partner.welcome', ref: partner.code });
}

/** ملخّص الصندوق للوحة التشغيل */
/* ══════════ طلبات الحجز ══════════ */
export const notifyRequestReceived = (r, opts) =>
  send({ to: r.customer?.email, template: 'request.received', ref: r.code, ...tplRequestReceived(r, opts) });

export const notifyRequestApproved = (r, opts) =>
  send({ to: r.customer?.email, template: 'request.approved', bookingId: opts?.booking?.id || null, ref: r.code, ...tplRequestApproved(r, opts) });

export const notifyRequestRejected = (r, reason) =>
  send({ to: r.customer?.email, template: 'request.rejected', ref: r.code, ...tplRequestRejected(r, reason) });

export async function notifyAdminNewRequest(r, opts) {
  const to = ENV.adminEmail || ENV.mailReplyTo || null;
  if (!to) return null;                                  // لا بريد إدارة مضبوط
  return send({ to, template: 'request.admin_alert', ref: r.code, ...tplAdminNewRequest(r, opts) });
}

export async function outboxSummary(limit = 20) {
  const rows = await repo.listOutbox(limit);
  const all = await repo.listOutbox(1000);
  return {
    mailer: mailerInfo(),
    counts: {
      total: all.length,
      queued: all.filter(r => r.status === 'queued').length,
      sent: all.filter(r => r.status === 'sent').length,
      failed: all.filter(r => r.status === 'failed').length,
    },
    recent: rows.map(r => ({
      id: r.id, to: r.to_addr, subject: r.subject, template: r.template,
      status: r.status, provider: r.provider, error: r.error,
      attempts: r.attempts, createdAt: r.created_at, sentAt: r.sent_at,
    })),
  };
}
