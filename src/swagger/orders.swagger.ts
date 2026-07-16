import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

export const SwaggerOrdersTag = () => ApiTags('Orders');

export const ApiPayOrder = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Pay for a won auction from my wallet (deposit is applied; seller is credited immediately)',
    }),
    ApiParam({ name: 'id', description: 'Order id' }),
    ApiOkResponse({ description: 'The completed order' }),
    ApiBadRequestResponse({
      description: 'Not awaiting payment / deadline passed / insufficient balance',
    }),
    ApiForbiddenResponse({ description: 'This order is not yours' }),
    ApiNotFoundResponse({ description: 'Order not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiMyOrders = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my orders as a buyer (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiMySales = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my sales as a seller (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiGetOrder = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        "Order detail — buyer or seller only; includes the counterpart's email for mailto: contact",
    }),
    ApiParam({ name: 'id', description: 'Order id' }),
    ApiOkResponse({ description: 'Order + counterpart { role, fullName, email }' }),
    ApiForbiddenResponse({ description: 'Not your order' }),
    ApiNotFoundResponse({ description: 'Order not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
