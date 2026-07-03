import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import {
  ForgotPasswordDTO,
  GoogleAuthDTO,
  LoginDTO,
  RegisterDTO,
  ResetPasswordDTO,
  VerifyEmailDTO,
} from '../modules/auth/dto/auth.dto';

export const SwaggerAuthTag = () => ApiTags('Auth');

export const ApiRegister = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Start registration — sends a verification code to the email',
      description:
        'No user is created yet. A 6-digit code is emailed; call ' +
        '`POST /auth/verify-email` with the code to finish and receive a JWT.',
    }),
    ApiBody({ type: RegisterDTO }),
    ApiOkResponse({ description: 'Verification code sent to the email' }),
    ApiConflictResponse({ description: 'Email already in use' }),
  );

export const ApiVerifyEmail = () =>
  applyDecorators(
    ApiOperation({ summary: 'Verify the email code and create the account' }),
    ApiBody({ type: VerifyEmailDTO }),
    ApiOkResponse({ description: 'Account created, returns JWT + user data' }),
    ApiNotFoundResponse({
      description: 'No pending verification for this email',
    }),
    ApiBadRequestResponse({
      description: 'Invalid / expired code or too many attempts',
    }),
    ApiConflictResponse({ description: 'Email already in use' }),
  );

export const ApiLogin = () =>
  applyDecorators(
    ApiOperation({ summary: 'Login with email & password' }),
    ApiBody({ type: LoginDTO }),
    ApiOkResponse({ description: 'Login successful, returns JWT + user data' }),
    ApiUnauthorizedResponse({ description: 'Invalid credentials' }),
  );

export const ApiGoogleAuth = () =>
  applyDecorators(
    ApiOperation({ summary: 'Sign in / register with Google' }),
    ApiBody({ type: GoogleAuthDTO }),
    ApiOkResponse({ description: 'Returns JWT + user data' }),
    ApiUnauthorizedResponse({ description: 'Invalid Google token' }),
  );

export const ApiValidateToken = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Validate current JWT and refresh token' }),
    ApiOkResponse({ description: 'Returns new JWT + user data' }),
    ApiUnauthorizedResponse({ description: 'Token is missing or invalid' }),
  );

export const ApiForgotPassword = () =>
  applyDecorators(
    ApiOperation({ summary: 'Request a password reset link by email' }),
    ApiBody({ type: ForgotPasswordDTO }),
    ApiOkResponse({
      description:
        'Always returns a generic message (does not reveal if the email exists)',
    }),
  );

export const ApiResetPassword = () =>
  applyDecorators(
    ApiOperation({ summary: 'Reset password using the emailed token' }),
    ApiBody({ type: ResetPasswordDTO }),
    ApiOkResponse({ description: 'Password reset successfully' }),
    ApiNotFoundResponse({ description: 'Invalid or expired reset token' }),
    ApiBadRequestResponse({ description: 'Reset token has expired' }),
  );
