import { Controller, Get, Post, Body, Req, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type {
  GoogleAuthDTO,
  LoginDTO,
  RegisterDTO,
  UserResponseDTO,
} from './dto/auth.dto';
import { IsPublic } from 'src/decorators/public.decorator';
import {
  loginValidationSchema,
  registerValidationSchema,
} from './util/auth.validation.schema';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import {
  SwaggerAuthTag,
  ApiRegister,
  ApiLogin,
  ApiGoogleAuth,
  ApiValidateToken,
} from 'src/swagger/auth.swagger';

@SwaggerAuthTag()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @IsPublic(true)
  @ApiRegister()
  register(
    @Body(new ZodValidationPipe(registerValidationSchema))
    registerDTO: RegisterDTO,
  ): Promise<UserResponseDTO> {
    return this.authService.register(registerDTO);
  }

  @Post('login')
  @IsPublic(true)
  @ApiLogin()
  @UsePipes(new ZodValidationPipe(loginValidationSchema))
  login(@Body() loginDTO: LoginDTO): Promise<UserResponseDTO> {
    return this.authService.login(loginDTO);
  }

  @Post('google')
  @IsPublic(true)
  @ApiGoogleAuth()
  googleAuth(@Body() googleAuthDTO: GoogleAuthDTO): Promise<UserResponseDTO> {
    return this.authService.googleAuth(googleAuthDTO);
  }

  @Get('validate')
  @ApiValidateToken()
  validate(@Req() request: Request): UserResponseDTO {
    return this.authService.validate(request.user!);
  }
}
