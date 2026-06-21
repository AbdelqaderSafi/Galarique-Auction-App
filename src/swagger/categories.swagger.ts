import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { CreateCategoryDTO } from '../modules/categories/dto/category.dto';

export const SwaggerCategoriesTag = () => ApiTags('Categories');

export const ApiListCategories = () =>
  applyDecorators(
    ApiOperation({ summary: 'List all categories (public)' }),
    ApiOkResponse({ description: 'Array of categories' }),
  );

export const ApiCreateCategory = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Create a category (admin only)' }),
    ApiBody({ type: CreateCategoryDTO }),
    ApiCreatedResponse({ description: 'Category created' }),
    ApiConflictResponse({ description: 'Category name already in use' }),
    ApiForbiddenResponse({ description: 'Admin role required' }),
  );
