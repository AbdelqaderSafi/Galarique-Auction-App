import { z } from 'zod';

// يجب أن تطابق قيم enum Category في schema.prisma
const CATEGORY_VALUES = [
  'ART',
  'WATCHES',
  'COLLECTIBLES',
  'JEWELRY',
  'FURNITURE',
  'BOOKS',
  'FASHION',
  'ELECTRONICS',
] as const;

// مدد المزاد المسموحة (تبدأ عند موافقة الأدمن)
export const DURATION_PRESETS = [3, 5, 7, 10] as const;

const price = z.number().positive().max(100_000_000);
const increment = z.number().positive().max(1_000_000);
const durationDays = z
  .number()
  .int()
  .refine(
    (v) => (DURATION_PRESETS as readonly number[]).includes(v),
    { message: 'durationDays must be one of 3, 5, 7, 10' },
  );

export const createAuctionSchema = z
  .object({
    objectId: z.string().uuid(),
    startingPrice: price,
    reservePrice: price.optional(),
    minBidIncrement: increment.optional(),
    durationDays,
  })
  .refine(
    (d) => d.reservePrice === undefined || d.reservePrice >= d.startingPrice,
    { message: 'reservePrice must be >= startingPrice', path: ['reservePrice'] },
  );

// التعديل مسموح فقط قبل الإطلاق (PENDING_REVIEW / REJECTED) — بدون objectId
// reservePrice تقبل null لمسحها؛ الفحص النهائي مقابل القيم المدمجة يتم في الخدمة
export const updateAuctionSchema = z.object({
  startingPrice: price.optional(),
  reservePrice: price.nullable().optional(),
  minBidIncrement: increment.optional(),
  durationDays: durationDays.optional(),
});

export const rejectAuctionSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const browseAuctionsQuerySchema = z.object({
  category: z.enum(CATEGORY_VALUES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z
    .enum(['endingSoon', 'newest', 'priceLow', 'priceHigh'])
    .default('endingSoon'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
