import { ApiProperty } from '@nestjs/swagger';
import type { Category } from 'generated/prisma/client';

export class CreateCategoryDTO {
  @ApiProperty({ example: 'Art' })
  name!: string;

  @ApiProperty({
    example: 'https://cdn.galleryq.com/icons/art.svg',
    required: false,
  })
  iconUrl?: string;
}

export type CategoryResponseDTO = Category;
