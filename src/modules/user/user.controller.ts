import { Body, Controller, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UserService } from './user.service';
import type { UserResponseDTO } from '../auth/dto/auth.dto';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import {
  updateProfileSchema,
  type UpdateProfileInput,
} from './util/user.validation.schema';
import { SwaggerUserTag, ApiUpdateProfile } from 'src/swagger/user.swagger';

@SwaggerUserTag()
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // إعدادات الحساب: username/dateOfBirth/phoneNumber — تعديل جزئي، بلا توثيق
  @Patch('me')
  @ApiUpdateProfile()
  updateProfile(
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileInput,
  ): Promise<UserResponseDTO['userData']> {
    return this.userService.updateProfile(req.user!.id, dto);
  }
}
