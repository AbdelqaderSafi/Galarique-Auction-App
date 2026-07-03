import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiServiceUnavailableResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';

export const SwaggerUploadsTag = () => ApiTags('Uploads');

export const ApiUploadImage = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Upload a single image to ImageKit' }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary' },
        },
        required: ['file'],
      },
    }),
    ApiOkResponse({ description: 'Returns the uploaded image URL + fileId' }),
    ApiBadRequestResponse({ description: 'No file / invalid file type' }),
    ApiServiceUnavailableResponse({
      description: 'ImageKit is not configured',
    }),
  );

export const ApiUploadImages = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Upload multiple images to ImageKit' }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string', format: 'binary' },
          },
        },
        required: ['files'],
      },
    }),
    ApiOkResponse({ description: 'Returns an array of uploaded images' }),
    ApiBadRequestResponse({ description: 'No files / invalid file type' }),
    ApiServiceUnavailableResponse({
      description: 'ImageKit is not configured',
    }),
  );

export const ApiDeleteImage = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Delete an image from ImageKit by fileId' }),
    ApiOkResponse({ description: 'Image deleted' }),
    ApiServiceUnavailableResponse({
      description: 'ImageKit is not configured',
    }),
  );
