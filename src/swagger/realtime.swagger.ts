import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';

export const SwaggerRealtimeTag = () => ApiTags('Realtime');

export const ApiAuctionStream = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'SSE stream of live auction events (bid, closed) — one per open auction screen',
      description:
        "Server-Sent Events. Send Authorization: Bearer <jwt>. Emits {type:'bid'|'closed'|'ping'}. On reconnect, resync via GET /auctions/:id and GET /auctions/:id/bids.",
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiOkResponse({ description: 'SSE stream opened (text/event-stream)' }),
    ApiUnauthorizedResponse({ description: 'Missing or invalid token' }),
    ApiNotFoundResponse({ description: 'Auction not found or not public' }),
  );

export const ApiMeStream = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'SSE stream of my personal events (outbid, won)',
      description:
        "Server-Sent Events. Emits {type:'outbid'|'won'|'ping'} for the authenticated user.",
    }),
    ApiOkResponse({ description: 'SSE stream opened (text/event-stream)' }),
    ApiUnauthorizedResponse({ description: 'Missing or invalid token' }),
  );
