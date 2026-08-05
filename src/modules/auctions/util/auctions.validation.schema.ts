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
const shortText = z.string().trim().max(60);
const dimension = z.number().positive().max(100_000);

// حقول إضافية يسمّيها البائع بنفسه (اسم + قيمة نصية) — من شاشة Details
export const MAX_CUSTOM_FIELDS = 5;
const MAX_LABEL_LEN = 30;
const MAX_VALUE_LEN = 120;

const customField = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL_LEN),
  value: z.string().trim().min(1).max(MAX_VALUE_LEN),
});

const hasUniqueLabels = (fields: { label: string }[]) => {
  const seen = new Set(fields.map((f) => f.label.toLowerCase()));
  return seen.size === fields.length;
};

// يصل كنص JSON من multipart (POST) وكمصفوفة فعلية من JSON (PATCH) — نقبل الاثنين
export const customFieldsSchema = z
  .union([z.string(), z.array(z.unknown())])
  .transform((raw, ctx) => {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw) as unknown[];
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'customFields must be a valid JSON array',
      });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(customField)
      .max(MAX_CUSTOM_FIELDS, {
        message: `customFields must contain at most ${MAX_CUSTOM_FIELDS} items`,
      })
      .refine(hasUniqueLabels, {
        message: 'customFields labels must be unique',
      }),
  );

const durationDays = z
  .number()
  .int()
  .refine((v) => (DURATION_PRESETS as readonly number[]).includes(v), {
    message: 'durationDays must be one of 1, 3, 7, 10',
  });

// إنشاء المزاد بالكامل — يُرسَل كـ multipart/form-data (الصور ملفات، والباقي نصوص).
// الصور (mainImage + images) تُعالَج كملفات في الـ controller، لا هنا.
// خطوة تمهيدية: نحذف الحقول الفارغة (نصوص "") ونحوّل saveAsDraft لقيمة منطقية،
// لأن multipart يبعث كل شيء كنصوص وقد يرسل حقولاً اختيارية فارغة.
const normalizeMultipartBody = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === '' || v === null) continue; // فارغ = غياب
    out[k] = v;
  }
  if ('saveAsDraft' in out) {
    out.saveAsDraft = out.saveAsDraft === true || out.saveAsDraft === 'true';
  }
  return out;
};

export const createAuctionBodySchema = z.preprocess(
  normalizeMultipartBody,
  z.object({
    category: z.enum(CATEGORY_VALUES),
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).optional(),
    era: z.string().trim().max(60).optional(),
    condition: z.string().trim().max(60).optional(),
    originality: z.string().trim().max(60).optional(),
    heightCm: z.coerce.number().positive().max(100_000).optional(),
    widthCm: z.coerce.number().positive().max(100_000).optional(),
    depthCm: z.coerce.number().positive().max(100_000).optional(),
    startingPrice: z.coerce.number().positive().max(100_000_000),
    customFields: customFieldsSchema.optional(),
    durationDays: z
      .coerce.number()
      .int()
      .refine((v) => (DURATION_PRESETS as readonly number[]).includes(v), {
        message: 'durationDays must be one of 1, 3, 7, 10',
      }),
    saveAsDraft: z.boolean().optional().default(false),
  }),
);
export type CreateAuctionBody = z.infer<typeof createAuctionBodySchema>;

// تعديل قبل الإطلاق (DRAFT/PENDING_REVIEW/REJECTED) — JSON بروابط الصور
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
  customFields: customFieldsSchema.optional(),
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

// كل مزادات بائع معيّن (عام) — Live وما انتهى (منتهي/مباع/غير مباع)، بدون فلترة إضافية
export const sellerAuctionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
