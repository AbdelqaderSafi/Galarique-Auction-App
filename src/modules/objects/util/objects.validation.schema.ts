import { z } from 'zod';

// يجب أن تطابق قيم enum Category في schema.prisma
export const createObjectSchema = z.object({
  category: z.enum([
    'ART',
    'WATCHES',
    'COLLECTIBLES',
    'JEWELRY',
    'FURNITURE',
    'BOOKS',
    'FASHION',
    'ELECTRONICS',
  ]),
  title: z.string().min(2).max(120),
  description: z.string().min(1).max(2000),
  era: z.string().max(60).optional(),
  condition: z.string().max(60).optional(),
  originality: z.string().max(60).optional(),
  authenticity: z.string().max(60).optional(),
  country: z.string().max(60).optional(),
  heightCm: z.number().positive().optional(),
  widthCm: z.number().positive().optional(),
  depthCm: z.number().positive().optional(),
  images: z.array(z.string().url()).max(10).optional(),
});

export const updateObjectSchema = createObjectSchema.partial();
