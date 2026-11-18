/**
 * ماريا — الحساب البريدي CCP (Algérie Poste): تحقّق + إخفاء + تحويل العملة.
 * دوال نقية بلا قاعدة بيانات — تُستخدم من الـledger والـAPI والواجهات.
 *
 * صيغ الحساب البريدي المقبولة:
 *   - 10 أرقام (رقم الحساب) + مفتاح من رقمين  → تُكوَّن RIP من 20 رقمًا
 *   - RIP كامل من 20 رقمًا (يبدأ عادة بـ 007)
 */

const digits = (v) => String(v ?? '').replace(/[\s\-.]/g, '');

/** يتحقّق من صحة رقم CCP + المفتاح ويعيد تمثيلًا موحّدًا */
export function validateCcp({ number, key, holder, agency } = {}) {
  const n = digits(number);
  const k = digits(key);
  const errors = [];

  if (!n) errors.push('رقم الحساب البريدي (CCP) مطلوب');
  else if (!/^\d{10}$/.test(n) && !/^\d{20}$/.test(n)) {
    errors.push('رقم CCP يجب أن يكون 10 أرقام (أو RIP من 20 رقمًا)');
  }
  if (k && !/^\d{1,2}$/.test(k)) errors.push('مفتاح الحساب يجب أن يكون رقمًا أو رقمين');
  if (!k && n && n.length === 10) errors.push('مفتاح الحساب (clé) مطلوب مع الرقم المختصر');
  if (!holder || String(holder).trim().length < 4) errors.push('اسم صاحب الحساب كما في الدفتر البريدي مطلوب');

  if (errors.length) {
    throw Object.assign(new Error(errors.join(' · ')), { statusCode: 400, errors });
  }
  return {
    number: n,
    key: k ? k.padStart(2, '0') : null,
    holder: String(holder).trim(),
    agency: agency ? String(agency).trim() : null,
  };
}

/** يخفي رقم الحساب قبل عرضه: ****4471/04 */
export function maskCcp(number, key) {
  const n = digits(number);
  if (!n) return null;
  const tail = n.slice(-4);
  return `****${tail}${key ? '/' + digits(key).padStart(2, '0') : ''}`;
}

/** يحذف أي بيانات حساسة قبل الإرجاع للواجهة */
export function publicAccount(a) {
  if (!a) return null;
  return {
    ownerType: a.owner_type,
    ownerCode: a.owner_code,
    method: a.method,
    holderName: a.holder_name,
    masked: maskCcp(a.ccp_number, a.ccp_key),
    agency: a.ccp_agency,
    currency: a.currency,
    verified: Boolean(a.verified),
    updatedAt: a.updated_at,
  };
}

/** تحويل العمولة (USD) إلى مبلغ الحساب البريدي (DZD) */
export function toDzd(amountUsd, rate) {
  const a = Number(amountUsd) || 0;
  const r = Number(rate) || 0;
  return Math.round(a * r * 100) / 100;
}
