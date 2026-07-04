import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiUnauthorizedResponse,
  ApiServiceUnavailableResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { VerifyPhoneDTO } from '../modules/seller-verification/dto/seller-verification.dto';

export const SwaggerSellerTag = () => ApiTags('Seller');

export const ApiVerifyPhone = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Verify a Palestinian phone via Firebase and become a SELLER',
      description:
        'Accepts a Firebase idToken (from client-side phone OTP). On success: ' +
        'grants the SELLER role, marks the phone verified, creates a SellerProfile, ' +
        'and returns a fresh JWT that already contains the SELLER role.',
    }),
    ApiBody({ type: VerifyPhoneDTO }),
    ApiOkResponse({
      description: 'Seller verified, returns new JWT + user data',
    }),
    ApiBadRequestResponse({
      description: 'Token has no phone / phone is not Palestinian (+970/+972)',
    }),
    ApiUnauthorizedResponse({
      description: 'Invalid or expired Firebase token',
    }),
    ApiConflictResponse({
      description: 'Phone already registered to another account',
    }),
    ApiServiceUnavailableResponse({
      description: 'Firebase is not configured',
    }),
  );
