import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

export const SwaggerFollowsTag = () => ApiTags('Follows');

export const ApiFollowSeller = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Follow a seller (idempotent)' }),
    ApiParam({ name: 'sellerId', description: 'Seller user id' }),
    ApiOkResponse({ description: '{ following: true }' }),
    ApiBadRequestResponse({ description: 'You cannot follow yourself' }),
    ApiNotFoundResponse({ description: 'Seller not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiUnfollowSeller = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Unfollow a seller (idempotent)' }),
    ApiParam({ name: 'sellerId', description: 'Seller user id' }),
    ApiOkResponse({ description: '{ following: false }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiListFollowing = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List sellers I follow (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
