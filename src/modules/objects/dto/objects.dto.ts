import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Category } from 'generated/prisma/client';
import type { Object as ArtObject, ObjectImage } from 'generated/prisma/client';

export class CreateObjectDTO {
  @ApiProperty({ enum: Category, example: Category.ART })
  category!: Category;

  @ApiProperty({ example: 'Classical painting-XL' })
  title!: string;

  @ApiProperty({ example: 'A rare 19th century oil painting in excellent condition.' })
  description!: string;

  @ApiProperty({ required: false, example: '19th Century' })
  era?: string;

  @ApiProperty({ required: false, example: 'Excellent' })
  condition?: string;

  @ApiProperty({ required: false, example: 'Original' })
  originality?: string;

  @ApiProperty({ required: false, example: 'Authenticated' })
  authenticity?: string;

  @ApiProperty({ required: false, example: 'France' })
  country?: string;

  @ApiProperty({ required: false, example: 120.5 })
  heightCm?: number;

  @ApiProperty({ required: false, example: 80 })
  widthCm?: number;

  @ApiProperty({ required: false, example: 3 })
  depthCm?: number;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Image URLs (uploaded via /uploads first)',
    example: ['https://ik.imagekit.io/demo/art.jpg'],
  })
  images?: string[];
}

export class UpdateObjectDTO extends PartialType(CreateObjectDTO) {}

export type ObjectResponseDTO = ArtObject & { images: ObjectImage[] };
