import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UsePipes,
  HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type {
  ForgotPasswordDTO,
  GoogleAuthDTO,
  LoginDTO,
  MessageResponseDTO,
  RegisterDTO,
  ResetPasswordDTO,
  UserResponseDTO,
  VerifyEmailDTO,
} from './dto/auth.dto';
import { IsPublic } from 'src/decorators/public.decorator';
import {
  forgotPasswordSchema,
  loginValidationSchema,
  registerValidationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './util/auth.validation.schema';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import {
  SwaggerAuthTag,
  ApiRegister,
  ApiVerifyEmail,
  ApiLogin,
  ApiGoogleAuth,
  ApiValidateToken,
  ApiForgotPassword,
  ApiResetPassword,
} from 'src/swagger/auth.swagger';

@SwaggerAuthTag()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @IsPublic(true)
  @HttpCode(200)
  @ApiRegister()
  register(
    @Body(new ZodValidationPipe(registerValidationSchema))
    registerDTO: RegisterDTO,
  ): Promise<MessageResponseDTO> {
    return this.authService.register(registerDTO);
  }

  @Post('verify-email')
  @IsPublic(true)
  @ApiVerifyEmail()
  @UsePipes(new ZodValidationPipe(verifyEmailSchema))
  verifyEmail(
    @Body() verifyEmailDTO: VerifyEmailDTO,
  ): Promise<UserResponseDTO> {
    return this.authService.verifyEmail(verifyEmailDTO);
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

  @Post('forgot-password')
  @IsPublic(true)
  @HttpCode(200)
  @ApiForgotPassword()
  @UsePipes(new ZodValidationPipe(forgotPasswordSchema))
  forgotPassword(
    @Body() forgotPasswordDTO: ForgotPasswordDTO,
  ): Promise<MessageResponseDTO> {
    return this.authService.forgotPassword(forgotPasswordDTO);
  }

  @Post('reset-password')
  @IsPublic(true)
  @HttpCode(200)
  @ApiResetPassword()
  @UsePipes(new ZodValidationPipe(resetPasswordSchema))
  resetPassword(
    @Body() resetPasswordDTO: ResetPasswordDTO,
  ): Promise<MessageResponseDTO> {
    return this.authService.resetPassword(resetPasswordDTO);
  }
}
