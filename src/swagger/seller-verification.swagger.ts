import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import {
  RequestVerificationDTO,
  VerifyPhoneDTO,
} from '../modules/seller-verification/dto/seller-verification.dto';

export const SwaggerSellerTag = () => ApiTags('Seller verification');

export const ApiRequestVerification = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Request a WhatsApp OTP to verify a Palestinian phone and become a seller',
    }),
    ApiBody({ type: RequestVerificationDTO }),
    ApiOkResponse({
      description:
        'Code sent via WhatsApp. In simulation mode (SELLER_OTP_SIMULATE=true) ' +
        'the response also includes the code: { message, code }.',
    }),
    ApiBadRequestResponse({ description: 'Invalid Palestinian mobile number' }),
    ApiConflictResponse({ description: 'Already a seller / phone already in use' }),
  );

export const ApiVerifyPhone = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Verify the WhatsApp OTP; grants the SELLER role' }),
    ApiBody({ type: VerifyPhoneDTO }),
    ApiOkResponse({ description: 'Phone verified, SELLER role granted' }),
    ApiBadRequestResponse({ description: 'Invalid or expired code' }),
  );

export const ApiResendPhoneCode = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Resend the WhatsApp verification code' }),
    ApiOkResponse({ description: 'A new code has been sent' }),
  );

export const ApiWhatsappStatus = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'WhatsApp link status + QR/pairing code for linking (admin only)',
    }),
    ApiOkResponse({ description: '{ connected, qr, pairingCode }' }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );

export const ApiWhatsappRelink = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Force a fresh WhatsApp link / new pairing code (admin only)',
    }),
    ApiOkResponse({
      description: 'Reconnecting; poll the status endpoint for a new code',
    }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );
