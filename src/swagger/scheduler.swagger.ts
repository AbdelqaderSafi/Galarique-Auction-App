import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';

export const SwaggerSchedulerTag = () => ApiTags('Scheduler');

export const ApiRunScheduler = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Run one settlement tick now (ADMIN) — closes due auctions, expires deadlines, retries winner payments',
    }),
    ApiOkResponse({ description: '{ closed, expired, retriedPaid }' }),
    ApiForbiddenResponse({ description: 'Admins only' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
