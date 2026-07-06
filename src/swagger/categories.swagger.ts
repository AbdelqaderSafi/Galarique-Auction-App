import { applyDecorators } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';

export const SwaggerCategoriesTag = () => ApiTags('Categories');

export const ApiListCategories = () =>
  applyDecorators(
    ApiOperation({ summary: 'List all categories (fixed enum, public)' }),
    ApiOkResponse({ description: 'Array of { value, label }' }),
  );
