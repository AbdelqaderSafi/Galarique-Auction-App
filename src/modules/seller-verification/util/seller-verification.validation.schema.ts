import { z } from 'zod';

export const requestVerificationSchema = z.object({
  phoneNumber: z.string().min(9).max(20),
});

export const verifyPhoneSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});
