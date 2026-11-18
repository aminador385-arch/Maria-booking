/**
 * مزوّد مدفوعات محاكى — يُحاكي دورة حياة PaymentIntent + 3-D Secure + استرداد.
 * يسمح بتجربة كل المسار (نية دفع → تحقّق → نجاح/فشل → استرداد) بلا مفاتيح.
 *
 * قواعد المحاكاة:
 *  • card ينتهي بـ 0002  → رفض من البنك
 *  • threeDS = 'fail'    → فشل التحقّق بخطوتين
 *  • غير ذلك             → نجاح
 */
const intents = new Map();

const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 12);

export const provider = 'sandbox';
export const supportsServerConfirm = true;

export async function createIntent({ amount, currency = 'USD', bookingId, method = 'card' }) {
  const id = rid('pi_sandbox');
  intents.set(id, { id, amount, currency, bookingId, method, status: 'requires_action' });
  return {
    providerRef: id,
    clientSecret: id + '_secret_' + Math.random().toString(36).slice(2, 10),
    status: 'requires_action',          // ينتظر تحقّق العميل (3DS)
    requiresAction: true,
    nextAction: { type: 'three_d_secure_redirect', url: `/pay?intent=${id}` },
  };
}

export async function confirm({ providerRef, threeDS = 'success', cardLast4 = null }) {
  const pi = intents.get(providerRef);
  if (!pi) return { status: 'failed', failureReason: 'intent غير موجود' };
  if (cardLast4 === '0002') {
    pi.status = 'failed';
    return { status: 'failed', failureReason: 'بطاقة مرفوضة من البنك (محاكاة)' };
  }
  if (threeDS === 'fail') {
    pi.status = 'failed';
    return { status: 'failed', failureReason: 'فشل التحقّق بخطوتين (3-D Secure)' };
  }
  pi.status = 'succeeded';
  return { status: 'succeeded', providerRef: pi.id };
}

export async function refund({ providerRef, amount }) {
  const pi = intents.get(providerRef);
  if (!pi) return { status: 'failed', failureReason: 'intent غير موجود' };
  pi.status = 'refunded';
  return { status: 'refunded', amount };
}

export async function retrieve({ providerRef }) {
  const pi = intents.get(providerRef);
  return pi ? { status: pi.status } : null;
}
