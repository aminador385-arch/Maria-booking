/**
 * محرّك التسعير — نموذج ماريا 3%
 * ------------------------------------------------------------------
 * العميل يدفع:  سعر المزوّد + 3% رسوم ماريا (شفافة على الفاتورة)
 * المنصة تكسب:  حصة من الـ3% + عمولة/هامش المزوّد − تكاليف المزوّد (Duffel…)
 * الشريك يكسب:  نصف الـ3% (1.5%) عند البيع بكوده
 */
import { MODEL, VERTICALS } from './config.js';

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function verticalRate(vertical) {
  const v = VERTICALS[vertical];
  if (!v) throw new Error('قطاع غير معروف: ' + vertical);
  return v.supplierRate;
}

/**
 * حساب تفصيل أي عرض/حجز.
 * @param {{vertical:string, price:number, ref?:string}} input
 */
export function quote({ vertical, price, ref = null, affiliateMode = false }) {
  const v = VERTICALS[vertical];
  if (!v) throw new Error('قطاع غير معروف: ' + vertical);
  if (!(price > 0)) throw new Error('سعر غير صالح');

  const basePrice = round(price);

  /* 1) رسوم ماريا 3% — يدفعها العميل بوضوح (تُلغى في وضع الإحالة) */
  const platformFee = affiliateMode ? 0 : round(basePrice * MODEL.feeRate);

  /* 2) عمولة/هامش المزوّد على قيمة الحجز */
  const supplierCommission = round(basePrice * v.supplierRate);

  /* 3) تكاليف تشغيل المزوّد (Duffel على الطيران فقط) */
  const providerCost = v.adapter === 'duffel'
    ? round(MODEL.duffelOrderFee + basePrice * MODEL.duffelManagedContent)
    : 0;

  /* 4) توزيع رسوم الـ3% بين المنصة والشريك */
  const isPartner = Boolean(ref) && ref.toUpperCase() !== 'MARIA';
  const partnerEarnings = isPartner ? round(platformFee * MODEL.partnerCut) : 0;
  const platformFeeShare = round(platformFee - partnerEarnings);

  /* 5) صافي المنصة = حصتها من الرسوم + عمولة المزوّد − تكلفة المزوّد */
  const platformNet = round(platformFeeShare + supplierCommission - providerCost);

  const customerTotal = round(basePrice + platformFee);

  /* وضع الإحالة/الوسيط: العميل يدفع للمزوّد مباشرة، وربحنا = عمولة المزوّد فقط */
  if (affiliateMode) {
    const partnerE = isPartner ? round(supplierCommission * MODEL.partnerCut) : 0;
    return {
      vertical, verticalName: v.name, currency: MODEL.currency,
      affiliateMode: true,
      basePrice, platformFee: 0, feeRate: 0, customerTotal,
      supplierCommission, supplierRate: v.supplierRate, providerCost,
      ref: isPartner ? ref.toUpperCase() : null,
      partnerEarnings: partnerE,
      platformFeeShare: 0,
      platformNet: round(supplierCommission - partnerE - providerCost),
      platformNetPct: round(((supplierCommission - partnerE - providerCost) / basePrice) * 100),
      note: 'وضع إحالة: الدفع يتم لدى المزوّد — العمولة تُقيَّد بعد مطابقة تقرير المزوّد',
    };
  }

  return {
    vertical,
    verticalName: v.name,
    currency: MODEL.currency,
    basePrice,             // سعر المزوّد
    platformFee,           // 3%
    feeRate: MODEL.feeRate,
    customerTotal,         // ما يدفعه العميل
    supplierCommission,    // عمولة/هامش المزوّد
    supplierRate: v.supplierRate,
    providerCost,          // تكاليف (Duffel…)
    ref: isPartner ? ref.toUpperCase() : null,
    partnerEarnings,       // حصة الشريك من الـ3%
    platformFeeShare,      // حصة المنصة من الـ3%
    platformNet,           // صافي ربح المنصة من هذا الحجز
    platformNetPct: round((platformNet / basePrice) * 100), // نسبة الربح الفعلية على قيمة الحجز
  };
}

export { round };
