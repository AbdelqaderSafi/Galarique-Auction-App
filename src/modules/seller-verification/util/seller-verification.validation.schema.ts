import { z, ZodType } from 'zod';
import { VerifyPhoneDTO } from '../dto/seller-verification.dto';

export const verifyPhoneSchema = z.object({
  idToken: z.string().min(1),
}) satisfies ZodType<VerifyPhoneDTO>;
