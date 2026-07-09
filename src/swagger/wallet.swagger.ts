import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiServiceUnavailableResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { TopUpDto, WithdrawDto } from '../modules/wallet/dto/wallet.dto';

export const SwaggerWalletTag = () => ApiTags('Wallet');

export const ApiGetWallet = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Get my wallet balance (creates the wallet on first access)',
    }),
    ApiOkResponse({ description: '{ balance, lockedBalance, currency }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiGetTransactions = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my wallet transactions (paginated)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiTopUp = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Create a Stripe Checkout session to top up the wallet',
    }),
    ApiBody({ type: TopUpDto }),
    ApiCreatedResponse({ description: '{ checkoutUrl } — redirect the client here' }),
    ApiBadRequestResponse({ description: 'amount must be a positive number' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
    ApiServiceUnavailableResponse({ description: 'Stripe is not configured' }),
  );

export const ApiStripeWebhook = () =>
  applyDecorators(
    ApiOperation({
      summary:
        'Stripe webhook (public — verified by signature). Credits the wallet on checkout.session.completed.',
    }),
    ApiHeader({ name: 'stripe-signature', required: true }),
    ApiOkResponse({ description: '{ received: true }' }),
    ApiBadRequestResponse({ description: 'Invalid Stripe signature' }),
  );

export const ApiConnectOnboard = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Create/continue Stripe Connect onboarding; returns an onboarding URL',
    }),
    ApiCreatedResponse({ description: '{ url } — redirect the client here' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
    ApiServiceUnavailableResponse({ description: 'Stripe is not configured' }),
  );

export const ApiConnectStatus = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Check my Stripe Connect account readiness' }),
    ApiOkResponse({
      description: '{ detailsSubmitted, chargesEnabled, payoutsEnabled }',
    }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiWithdraw = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'Withdraw balance to my connected account (synchronous transfer)',
    }),
    ApiBody({ type: WithdrawDto }),
    ApiCreatedResponse({ description: '{ withdrawalId, status }' }),
    ApiBadRequestResponse({
      description: 'Insufficient balance / payouts not enabled / invalid amount',
    }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
