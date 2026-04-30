import { validationSchema } from 'src/modules/user/util/user.validation.schema';
import { ZodType } from 'zod';
import { LoginDTO } from '../dto/auth.dto';

export const registerValidationSchema = validationSchema;

export const loginValidationSchema = validationSchema.pick({
  email: true,
  password: true,
}) satisfies ZodType<LoginDTO>;
