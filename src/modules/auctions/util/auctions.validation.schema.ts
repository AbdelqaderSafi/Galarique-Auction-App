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

// مدد المزاد المسموحة (بالأيام) — تبدأ عند موافقة الأدمن (من شاشة Auction Duration)
export const DURATION_PRESETS = [1, 3, 7, 10] as const;

const price = z.number().positive().max(100_000_000);
const increment = z.number().positive().max(1_000_000);
const shortText = z.string().trim().max(60);
const dimension = z.number().positive().max(100_000);
const durationDays = z
  .number()
  .int()
  .refine((v) => (DURATION_PRESETS as readonly number[]).includes(v), {
    message: 'durationDays must be one of 1, 3, 7, 10',
  });

// حقول القطعة (خطوتا Category + Details + Images) — تُنشأ مع المزاد
const objectFields = {
  category: z.enum(CATEGORY_VALUES),
  mainImage: z.string().url(), // الصورة الرئيسية (الغلاف) — مطلوبة
  images: z.array(z.string().url()).max(10).optional(), // صور إضافية (حتى 10)
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  era: shortText.optional(),
  condition: shortText.optional(),
  originality: shortText.optional(),
  heightCm: dimension.optional(),
  widthCm: dimension.optional(),
  depthCm: dimension.optional(),
};

// إنشاء المزاد بالكامل (كل خطوات الـ wizard في طلب واحد)
export const createAuctionSchema = z.object({
  ...objectFields,
  // خطوة Set Value — بدون reserve/second-chance
  startingPrice: price,
  minBidIncrement: increment.optional(),
  // خطوة Auction Duration
  durationDays,
  // خطوة Review: Next (false) أو Save as Draft (true)
  saveAsDraft: z.boolean().optional().default(false),
});

// تعديل قبل الإطلاق (DRAFT/PENDING_REVIEW/REJECTED) — كل الحقول اختيارية، بدون saveAsDraft
export const updateAuctionSchema = z.object({
  category: z.enum(CATEGORY_VALUES).optional(),
  mainImage: z.string().url().optional(),
  images: z.array(z.string().url()).max(10).optional(),
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  era: shortText.nullable().optional(),
  condition: shortText.nullable().optional(),
  originality: shortText.nullable().optional(),
  heightCm: dimension.nullable().optional(),
  widthCm: dimension.nullable().optional(),
  depthCm: dimension.nullable().optional(),
  startingPrice: price.optional(),
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
