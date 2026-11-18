/**
 * ماريا — الفوترة الرسمية (سجل تجاري + تعريف جبائي)
 * كل فاتورة تحمل لقطة من الهوية القانونية وقت الإصدار (لا تتغيّر بأثر رجعي).
 *
 * القاعدة: لا فاتورة إلا على حجز مؤكَّد دفعت فيه المنصة مالًا.
 * في وضع الإحالة، الفاتورة تصدرها الجهة المزوّدة (العميل يدفع لها مباشرة).
 */
import { MODEL, ENV, LEGAL, VERTICALS } from './config.js';
import * as repo from './db/repo.js';
import * as notify from './notify.js';

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n, c = 'USD') => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n || 0)) + ' ' + (c === 'DZD' ? 'دج' : '$');

/** هل الفوترة صالحة قانونيًا؟ */
export function legalState() {
  return {
    company: LEGAL.name,
    rc: LEGAL.rc ? '***' + LEGAL.rc.slice(-4) : '',
    nif: LEGAL.nif ? '***' + LEGAL.nif.slice(-3) : '',
    address: LEGAL.address,
    vatRegistered: LEGAL.vatRegistered,
    vatRate: LEGAL.vatRate,
    ready: LEGAL.ready,
    missing: [
      !LEGAL.rc ? 'MARIA_RC_NUMBER (السجل التجاري)' : null,
      !LEGAL.nif ? 'MARIA_NIF (التعريف الجبائي)' : null,
    ].filter(Boolean),
  };
}

/** يبني أسطر الفاتورة من تسعير الحجز (بدون تدخّل في المبالغ المدفوعة) */
export function buildLines(booking) {
  const q = booking.pricing || {};
  const c = q.currency || MODEL.currency;
  const lines = [{
    label: `خدمة ${VERTICALS[booking.vertical]?.name || booking.vertical} — ${booking.offer?.title || ''}`.trim(),
    qty: 1, unit: round(q.basePrice), amount: round(q.basePrice), kind: 'supplier',
  }];

  if (q.platformFee > 0) {
    if (LEGAL.vatRegistered) {
      const ttc = round(q.platformFee);
      const ht = round(ttc / (1 + LEGAL.vatRate));
      const tva = round(ttc - ht);
      lines.push({ label: 'رسوم خدمة ماريا 3% (دون رسم)', qty: 1, unit: ht, amount: ht, kind: 'fee_ht' });
      lines.push({ label: `الرسم على القيمة المضافة ${(LEGAL.vatRate * 100).toFixed(0)}%`, qty: 1, unit: tva, amount: tva, kind: 'vat' });
    } else {
      lines.push({ label: 'رسوم خدمة ماريا 3%', qty: 1, unit: round(q.platformFee), amount: round(q.platformFee), kind: 'fee' });
    }
  }
  return { lines, currency: c, subtotal: round(q.basePrice + (q.platformFee || 0)) };
}

/**
 * يُصدر فاتورة لحجز مؤكَّد (مرة واحدة لكل حجز).
 * @returns {Promise<object>} الفاتورة (الجديدة أو الموجودة)
 */
export async function issueInvoice(bookingId) {
  const existing = await repo.getInvoiceByBooking(bookingId);
  if (existing) return { invoice: existing, replayed: true };

  const booking = await repo.getBooking(bookingId);
  if (!booking) throw Object.assign(new Error('حجز غير موجود'), { statusCode: 404 });
  if (booking.pricing?.affiliateMode) {
    throw Object.assign(new Error('وضع الإحالة: العميل يدفع للمزوّد مباشرة — الفاتورة تصدرها الجهة المزوّدة'), { statusCode: 409 });
  }
  if (!['confirmed', 'fulfilled'].includes(booking.status)) {
    throw Object.assign(new Error('الفاتورة تصدر بعد تأكيد الحجز فقط (الحالة الحالية: ' + booking.status + ')'), { statusCode: 409 });
  }
  if (!LEGAL.ready) {
    throw Object.assign(new Error('أكمل الهوية القانونية أولًا: ' + legalState().missing.join(' · ')), { statusCode: 428 });
  }

  const year = new Date().getFullYear();
  const seq = await repo.nextInvoiceSeq(year);
  const number = `MARIA-${year}-${String(seq).padStart(6, '0')}`;
  const { lines, currency, subtotal } = buildLines(booking);
  const vatAmount = round(lines.filter(l => l.kind === 'vat').reduce((a, l) => a + l.amount, 0));
  const total = round(subtotal);

  const invoice = await repo.addInvoice({
    id: 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    number, year, seq, bookingId,
    customer: booking.customer || {},
    seller: {
      name: LEGAL.name, rc: LEGAL.rc, nif: LEGAL.nif, ai: LEGAL.ai,
      address: LEGAL.address, phone: LEGAL.phone, email: LEGAL.email,
      vatRegistered: LEGAL.vatRegistered,
    },
    lines, subtotal, vatAmount, total, currency,
    totalDzd: round(total * ENV.dzdPerUsd), fxRate: ENV.dzdPerUsd,
    status: 'issued',
  });
  await repo.addAudit('invoice.issued', { number, bookingId, total });

  /* إرسال الفاتورة للعميل (fire-and-forget) */
  notify.notifyInvoice(invoice, booking.customer?.email).catch(() => {});
  return { invoice, replayed: false };
}

/** فاتورة جاهزة للطباعة (HTML بلا موارد خارجية) */
export function invoiceHtml(inv) {
  const cur = inv.currency || 'USD';
  const rows = (inv.lines || []).map(l => `
    <tr>
      <td>${l.label}</td>
      <td class="num">${l.qty}</td>
      <td class="num">${money(l.unit, cur)}</td>
      <td class="num">${money(l.amount, cur)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>فاتورة ${inv.number} — ${inv.seller?.name || 'ماريا'}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:"Segoe UI",Tahoma,system-ui,sans-serif;background:#f6f7fb;color:#0d1526;margin:0;padding:24px}
  .sheet{max-width:820px;margin:0 auto;background:#fff;border-radius:16px;padding:34px 34px 26px;box-shadow:0 10px 40px rgba(13,21,38,.10)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid #eef1f7;padding-bottom:18px}
  .brand{font-size:21px;font-weight:900;letter-spacing:-.5px}
  .brand small{display:block;font-size:11px;color:#68738a;font-weight:700;letter-spacing:1px;margin-top:2px}
  .meta{text-align:left;font-size:12px;color:#4d5872;line-height:1.9}
  .meta b{color:#0d1526}
  h2{font-size:14px;margin:22px 0 8px;color:#4d5872;font-weight:800}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .box{background:#f8fafc;border:1px solid #eef1f7;border-radius:12px;padding:12px 14px;font-size:12.5px;line-height:1.9}
  .box b{display:block;font-size:11px;color:#68738a;margin-bottom:3px;letter-spacing:.5px}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}
  th{background:#0d1526;color:#fff;text-align:right;padding:9px 10px;font-size:11.5px}
  td{padding:9px 10px;border-bottom:1px solid #eef1f7}
  .num{text-align:left;font-variant-numeric:tabular-nums;white-space:nowrap}
  .totals{margin-top:14px;margin-inline-start:auto;width:320px;font-size:13px}
  .totals div{display:flex;justify-content:space-between;padding:6px 0}
  .totals .grand{border-top:2px solid #0d1526;margin-top:6px;padding-top:9px;font-weight:900;font-size:15px}
  .dzd{font-size:11.5px;color:#68738a;text-align:left;margin-top:4px}
  .legal{margin-top:22px;border-top:1px dashed #d8dfeb;padding-top:12px;font-size:10.5px;color:#68738a;line-height:1.9}
  .stamp{display:inline-block;border:2px solid #16a34a;color:#16a34a;border-radius:10px;padding:6px 12px;font-weight:900;font-size:11px;transform:rotate(-4deg)}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0}}
</style></head>
<body>
  <div class="sheet">
    <div class="top">
      <div class="brand">${inv.seller?.name || 'ماريا'}<small>MARIA — BOOKING &amp; TRAVEL SERVICES</small></div>
      <div class="meta">
        <b>فاتورة / FACTURE</b><br>
        رقم: <b>${inv.number}</b><br>
        التاريخ: ${new Date(inv.issued_at).toLocaleDateString('fr-DZ')}<br>
        الحجز: ${String(inv.booking_id).slice(-8)}
      </div>
    </div>

    <h2>البائع</h2>
    <div class="grid">
      <div class="box"><b>المؤسسة</b>${inv.seller?.name || '—'}<br>
        <b style="margin-top:6px">السجل التجاري</b>${inv.seller?.rc || '—'}<br>
        <b style="margin-top:6px">التعريف الجبائي (NIF)</b>${inv.seller?.nif || '—'}${inv.seller?.ai ? '<br><b style="margin-top:6px">المادة الجبائية</b>' + inv.seller.ai : ''}
      </div>
      <div class="box"><b>العنوان</b>${inv.seller?.address || '—'}<br>
        <b style="margin-top:6px">الهاتف</b>${inv.seller?.phone || '—'}<br>
        <b style="margin-top:6px">البريد</b>${inv.seller?.email || '—'}<br>
        <b style="margin-top:6px">النظام الجبائي</b>${inv.seller?.vatRegistered ? 'مرتّب على الرسم على القيمة المضافة' : 'غير مرتّب على الرسم (TVA)'}
      </div>
    </div>

    <h2>العميل</h2>
    <div class="box">${inv.customer?.name || 'عميل'}${inv.customer?.email ? ' · ' + inv.customer.email : ''}${inv.customer?.phone ? ' · ' + inv.customer.phone : ''}</div>

    <table>
      <thead><tr><th>البيان</th><th class="num">الكمية</th><th class="num">السعر</th><th class="num">المجموع</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totals">
      <div><span>المجموع</span><span>${money(inv.subtotal, cur)}</span></div>
      ${Number(inv.vat_amount) > 0 ? `<div><span>منه الرسم على القيمة المضافة</span><span>${money(inv.vat_amount, cur)}</span></div>` : ''}
      <div class="grand"><span>الإجمالي المستحق</span><span>${money(inv.total, cur)}</span></div>
      <div class="dzd">ما يعادل ${money(inv.total_dzd, 'DZD')} بسعر ${inv.fx_rate} دج للدولار</div>
    </div>

    <div style="margin-top:18px"><span class="stamp">مدفوعة ✓</span></div>

    <div class="legal">
      هذه الفاتورة صادرة إلكترونيًا عن ${inv.seller?.name || 'ماريا'} · سجل تجاري ${inv.seller?.rc || '—'} · NIF ${inv.seller?.nif || '—'}.<br>
      رسوم الخدمة (3%) هي مقابل وساطة/حجز تقني؛ قيمة الخدمة الأساسية تخصّ الجهة المزوّدة.<br>
      تُحفظ نسخة إلكترونية في سجل الفواتير ولا تُعدّل بعد الإصدار — أي تصحيح يتم بفاتورة/إشعار جديد.
    </div>
  </div>
</body></html>`;
}
