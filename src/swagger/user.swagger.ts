import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { UpdateProfileDTO } from '../modules/user/dto/user.dto';

export const SwaggerUserTag = () => ApiTags('Users');

export const ApiUpdateProfile = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Update account settings — username / date of birth / phone number (all optional, no verification)',
    }),
    ApiBody({ type: UpdateProfileDTO }),
    ApiOkResponse({ description: 'Updated user (without password)' }),
    ApiBadRequestResponse({ description: 'Invalid field(s) / no field provided' }),
    ApiConflictResponse({ description: 'Username already taken' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
