import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

export const SwaggerFavoritesTag = () => ApiTags('Favorites');

export const ApiAddFavoriteAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Add an auction to my favorites (idempotent)' }),
    ApiParam({ name: 'auctionId', description: 'Auction id' }),
    ApiOkResponse({ description: '{ favorited: true }' }),
    ApiNotFoundResponse({ description: 'Auction not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiRemoveFavoriteAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Remove an auction from my favorites (idempotent)' }),
    ApiParam({ name: 'auctionId', description: 'Auction id' }),
    ApiOkResponse({ description: '{ favorited: false }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiListFavoriteAuctions = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my favorite auctions (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
