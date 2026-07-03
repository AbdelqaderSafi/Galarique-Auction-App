import { validationSchema } from 'src/modules/user/util/user.validation.schema';
import { z, ZodType } from 'zod';
import {
  ForgotPasswordDTO,
  LoginDTO,
  ResetPasswordDTO,
  VerifyEmailDTO,
} from '../dto/auth.dto';

export const registerValidationSchema = validationSchema;

export const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
}) satisfies ZodType<VerifyEmailDTO>;

export const loginValidationSchema = validationSchema.pick({
  email: true,
  password: true,
}) satisfies ZodType<LoginDTO>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
}) satisfies ZodType<ForgotPasswordDTO>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
}) satisfies ZodType<ResetPasswordDTO>;
