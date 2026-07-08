import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiForbiddenResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {
  CreateAuctionDTO,
  UpdateAuctionDTO,
  RejectAuctionDTO,
} from '../modules/auctions/dto/auctions.dto';

export const SwaggerAuctionsTag = () => ApiTags('Auctions');

export const ApiCreateAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Create an auction from an AVAILABLE object (seller only)',
    }),
    ApiBody({ type: CreateAuctionDTO }),
    ApiCreatedResponse({ description: 'Auction created (status PENDING_REVIEW)' }),
    ApiBadRequestResponse({ description: 'Object not available / invalid input' }),
    ApiNotFoundResponse({ description: 'Object not found' }),
    ApiForbiddenResponse({ description: 'Not the owner / seller role required' }),
  );

export const ApiListMyAuctions = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: "List the current seller's own auctions" }),
    ApiOkResponse({ description: 'Array of auctions with object + images' }),
  );

export const ApiUpdateAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Edit an auction before it goes live (pending/rejected only)',
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiBody({ type: UpdateAuctionDTO }),
    ApiOkResponse({ description: 'Updated auction (rejected → back to pending)' }),
    ApiBadRequestResponse({ description: 'Not editable in its current status' }),
    ApiForbiddenResponse({ description: 'Not the owner' }),
  );

export const ApiCancelAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Cancel an auction (seller: pending/rejected · admin: any) → object freed',
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiOkResponse({ description: 'Auction CANCELLED, object back to AVAILABLE' }),
    ApiBadRequestResponse({ description: 'Auction cannot be cancelled' }),
    ApiForbiddenResponse({ description: 'Not the owner / admin' }),
  );

export const ApiBrowseAuctions = () =>
  applyDecorators(
    ApiOperation({ summary: 'Browse LIVE auctions (public)' }),
    ApiQuery({ name: 'category', required: false }),
    ApiQuery({ name: 'q', required: false, description: 'Search object title' }),
    ApiQuery({
      name: 'sort',
      required: false,
      enum: ['endingSoon', 'newest', 'priceLow', 'priceHigh'],
    }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, total, page, limit }' }),
  );

export const ApiGetAuction = () =>
  applyDecorators(
    ApiOperation({ summary: 'Get a public auction detail (with bid count)' }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiOkResponse({ description: 'The auction with object, images and bidCount' }),
    ApiNotFoundResponse({ description: 'Auction not found or not public' }),
  );

export const ApiPendingAuctions = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Admin review queue (PENDING_REVIEW)' }),
    ApiOkResponse({ description: 'Array of pending auctions, oldest first' }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );

export const ApiApproveAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Approve a pending auction → LIVE (admin only)' }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiOkResponse({ description: 'Auction is now LIVE with start/end time' }),
    ApiBadRequestResponse({ description: 'Auction is not pending review' }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );

export const ApiRejectAuction = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Reject a pending auction with a reason (admin only)' }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiBody({ type: RejectAuctionDTO }),
    ApiOkResponse({ description: 'Auction REJECTED with rejectionReason' }),
    ApiBadRequestResponse({ description: 'Auction is not pending review' }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );
