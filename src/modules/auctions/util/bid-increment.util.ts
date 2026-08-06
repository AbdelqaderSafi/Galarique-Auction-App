import { Prisma } from 'generated/prisma/client';

// جدول الزيادة المتدرّجة — الحد الأدنى للزيادة يتبع السعر الحالي، لا يختاره البائع.
// الحدود مغلقة من الأسفل: سعر 100 بالضبط يقع في شريحة الـ10، و1000 بالضبط في شريحة الـ50.
// مرتّب تنازلياً ليصحّ أول تطابق في find().
const TIERS = [
  { from: 1000, increment: 50 },
  { from: 100, increment: 10 },
  { from: 25, increment: 2 },
  { from: 0, increment: 1 },
] as const;

// هذه الدالة هي المصدر الوحيد للحقيقة: عمود Auction.minBidIncrement مجرّد نسخة
// محفوظة للقراءة (يكتبها الباك اند بعد كل تغيّر سعر)، ولا يُستخدم أبداً في التحقق.
export function minIncrementFor(
  price: Prisma.Decimal | number | string,
): Prisma.Decimal {
  const value = new Prisma.Decimal(price);
  // القيم السالبة لا تحدث عملياً (السعر دائماً ≥ 0)، لكن نضمن شريحة صالحة على أي حال
  const tier =
    TIERS.find((t) => value.greaterThanOrEqualTo(t.from)) ?? TIERS[TIERS.length - 1];
  return new Prisma.Decimal(tier.increment);
}

// السعر الذي تُحسب منه الشريحة: السعر الحالي، أو سعر الافتتاح قبل أول مزايدة
// (currentPrice يبقى 0 حتى أول مزايدة، وشريحة الصفر ستعطي 1 دائماً وهو مضلّل).
export function incrementBasis(
  currentPrice: Prisma.Decimal | number | string,
  startingPrice: Prisma.Decimal | number | string,
): Prisma.Decimal {
  const current = new Prisma.Decimal(currentPrice);
  return current.greaterThan(0) ? current : new Prisma.Decimal(startingPrice);
}
