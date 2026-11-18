/** اختيار مزوّد المدفوعات: sandbox (محاكاة كاملة) أو stripe (حقيقي). */
import { ENV } from '../config.js';
import * as sandbox from './sandbox.js';
import * as stripe from './stripe.js';
import * as chargily from './chargily.js';

export function pay() {
  if (ENV.paymentProvider === 'stripe') return stripe;
  if (ENV.paymentProvider === 'chargily') return chargily;
  if (ENV.paymentProvider === 'none') return null;
  return sandbox;
}

export const paymentInfo = () => {
  const p = ENV.paymentProvider;
  if (p === 'none') return {
    provider: 'none (وضع الإحالة)',
    live: true,
    webhookSecretSet: false,
    note: 'لا نستلم أموال العملاء: يدفع العميل لدى المزوّد، والعمولة تُقيَّد بعد المطابقة',
  };
  if (p === 'stripe') return {
    provider: ENV.stripeSecret ? 'stripe (live keys)' : 'stripe (مفتاح ناقص)',
    live: Boolean(ENV.stripeSecret),
    webhookSecretSet: Boolean(ENV.stripeWebhookSecret),
    note: 'التأكيد في المتصفح (Stripe.js) والاعتماد على Webhook',
  };
  if (p === 'chargily') return {
    provider: ENV.chargilyKey ? `chargily (${ENV.chargilyTest ? 'test' : 'live'})` : 'chargily (مفتاح ناقص)',
    live: Boolean(ENV.chargilyKey) && !ENV.chargilyTest,
    webhookSecretSet: Boolean(ENV.chargilyWebhookSecret),
    note: 'الدفع بالدينار (CIB/EDAHABIA) — التأكيد عبر Webhook',
  };
  return {
    provider: 'sandbox', live: false,
    webhookSecretSet: Boolean(ENV.stripeWebhookSecret || ENV.chargilyWebhookSecret),
    note: 'محاكاة كاملة: نية دفع → 3DS → نجاح/فشل → استرداد',
  };
};
