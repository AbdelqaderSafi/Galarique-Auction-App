import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PlaceBidDto } from '../modules/bids/dto/bids.dto';

export const SwaggerBidsTag = () => ApiTags('Bids');

export const ApiPlaceBid = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Place a bid on a LIVE auction (holds a $50 deposit; releases the previous leader\'s)',
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiBody({ type: PlaceBidDto }),
    ApiCreatedResponse({
      description:
        '{ bidId, amount, currentPrice, endTime, isHighest, depositHeld }',
    }),
    ApiBadRequestResponse({
      description:
        'Not live / below minimum / already highest / insufficient $50 deposit balance',
    }),
    ApiForbiddenResponse({ description: 'You cannot bid on your own auction' }),
    ApiNotFoundResponse({ description: 'Auction not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiAuctionBids = () =>
  applyDecorators(
    ApiOperation({ summary: 'Public bid history for an auction (highest first)' }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiNotFoundResponse({ description: 'Auction not found' }),
  );

export const ApiMyBids = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my bids across all auctions (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
