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
} from '@nestjs/swagger';
import {
  CreateObjectDTO,
  UpdateObjectDTO,
} from '../modules/objects/dto/objects.dto';

export const SwaggerObjectsTag = () => ApiTags('Objects');

export const ApiCreateObject = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Create an object / artwork (seller only)' }),
    ApiBody({ type: CreateObjectDTO }),
    ApiCreatedResponse({ description: 'Object created (status AVAILABLE)' }),
    ApiNotFoundResponse({ description: 'Category not found' }),
    ApiForbiddenResponse({ description: 'Seller role required' }),
  );

export const ApiListMyObjects = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: "List the current seller's own objects" }),
    ApiOkResponse({ description: 'Array of objects with images' }),
  );

export const ApiGetObject = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Get one object (owner or admin)' }),
    ApiParam({ name: 'id', description: 'Object id' }),
    ApiOkResponse({ description: 'The object with images' }),
    ApiNotFoundResponse({ description: 'Object not found' }),
    ApiForbiddenResponse({ description: 'Not the owner' }),
  );

export const ApiUpdateObject = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Update an object (owner; not while in auction/sold)' }),
    ApiParam({ name: 'id', description: 'Object id' }),
    ApiBody({ type: UpdateObjectDTO }),
    ApiOkResponse({ description: 'Updated object' }),
    ApiBadRequestResponse({ description: 'Object is in auction or sold' }),
    ApiForbiddenResponse({ description: 'Not the owner' }),
  );

export const ApiDeleteObject = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Delete an object (owner; not while in auction/sold)' }),
    ApiParam({ name: 'id', description: 'Object id' }),
    ApiOkResponse({ description: 'Object deleted' }),
    ApiBadRequestResponse({ description: 'Object is in auction or sold' }),
    ApiForbiddenResponse({ description: 'Not the owner' }),
  );
