import { z } from 'zod';

export const validationSchema = z.object({
  fullName: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

// كل الحقول اختيارية — تعديل جزئي، لازم على الأقل حقل واحد
export const updateProfileSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(30, 'Username must be at most 30 characters')
      .regex(
        /^[a-zA-Z0-9_.]+$/,
        'Username can only contain letters, numbers, dots and underscores',
      ),
    dateOfBirth: z.coerce
      .date()
      .refine((d) => d <= new Date(), 'Date of birth cannot be in the future'),
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number'),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
