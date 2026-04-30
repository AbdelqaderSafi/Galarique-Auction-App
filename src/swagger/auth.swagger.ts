import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import {
  GoogleAuthDTO,
  LoginDTO,
  RegisterDTO,
} from '../modules/auth/dto/auth.dto';

export const SwaggerAuthTag = () => ApiTags('Auth');

export const ApiRegister = () =>
  applyDecorators(
    ApiOperation({ summary: 'Register a new account (email & password)' }),
    ApiBody({ type: RegisterDTO }),
    ApiCreatedResponse({ description: 'User registered, returns JWT + user data' }),
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
