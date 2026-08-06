import { Prisma } from 'generated/prisma/client';
import { incrementBasis, minIncrementFor } from './bid-increment.util';

describe('minIncrementFor', () => {
  // كل صف: [السعر, الزيادة المتوقعة] — الحدود بالضبط هي ما يهم
  it.each([
    [0, 1],
    [0.5, 1],
    [24.99, 1],
    [25, 2], // حد
    [25.01, 2],
    [99.99, 2],
    [100, 10], // حد — الشريحة الأعلى تفوز
    [100.01, 10],
    [999.99, 10],
    [1000, 50], // حد — الشريحة الأعلى تفوز
    [1000.01, 50],
    [5000, 50],
    [1_000_000, 50],
  ])('price %p → increment %p', (price, expected) => {
    expect(minIncrementFor(price).toNumber()).toBe(expected);
  });

  it('accepts Decimal and string inputs, not just numbers', () => {
    expect(minIncrementFor(new Prisma.Decimal('100.00')).toNumber()).toBe(10);
    expect(minIncrementFor('999.99').toNumber()).toBe(10);
  });

  it('returns a Decimal so it can be added to a price directly', () => {
    const currentPrice = new Prisma.Decimal('99.99');
    expect(currentPrice.add(minIncrementFor(currentPrice)).toFixed(2)).toBe(
      '101.99',
    );
  });

  // الحماية من قيمة سالبة غير متوقعة — يجب ألا ترمي استثناء
  it('falls back to the lowest tier for a negative price', () => {
    expect(minIncrementFor(-5).toNumber()).toBe(1);
  });
});

describe('incrementBasis', () => {
  it('uses startingPrice before the first bid (currentPrice is 0)', () => {
    expect(incrementBasis(0, 500).toNumber()).toBe(500);
    expect(minIncrementFor(incrementBasis(0, 500)).toNumber()).toBe(10);
  });

  it('uses currentPrice once bidding has started', () => {
    expect(incrementBasis(1200, 500).toNumber()).toBe(1200);
    expect(minIncrementFor(incrementBasis(1200, 500)).toNumber()).toBe(50);
  });

  it('never lets an unbid auction fall into the $1 tier because of its 0 price', () => {
    // بدون incrementBasis كان مزاد يفتح بـ 5000 يعرض زيادة 1 قبل أول مزايدة
    expect(minIncrementFor(0).toNumber()).toBe(1);
    expect(minIncrementFor(incrementBasis(0, 5000)).toNumber()).toBe(50);
  });
});
