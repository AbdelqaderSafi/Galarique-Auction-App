import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Category } from 'generated/prisma/client';
import type {
  Auction,
  Object as ArtObject,
  ObjectImage,
} from 'generated/prisma/client';

// إنشاء المزاد بالكامل — كل خطوات الـ wizard (Category → Images → Details → Set Value → Duration → Review)
export class CreateAuctionDTO {
  // 1. Category
  @ApiProperty({ enum: Category, example: Category.ART })
  category!: Category;

  // 2. Images (ارفعها عبر /uploads أولاً)
  @ApiProperty({
    description: 'Main/cover image URL shown in the UI',
    example: 'https://ik.imagekit.io/demo/cover.jpg',
  })
  mainImage!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Additional product image URLs (up to 10)',
    example: ['https://ik.imagekit.io/demo/1.jpg'],
  })
  images?: string[];

  // 3. Details
  @ApiProperty({ example: 'Still Life with Flowers' })
  title!: string;

  @ApiPropertyOptional({ example: 'A rare 17th century oil painting.' })
  description?: string;

  @ApiPropertyOptional({ example: '18th Century' })
  era?: string;

  @ApiPropertyOptional({ example: 'Excellent' })
  condition?: string;

  @ApiPropertyOptional({ example: 'Original' })
  originality?: string;

  @ApiPropertyOptional({ example: 120.5 })
  heightCm?: number;

  @ApiPropertyOptional({ example: 80 })
  widthCm?: number;

  @ApiPropertyOptional({ example: 3 })
  depthCm?: number;

  // 4. Set Value
  @ApiProperty({ example: 1000, description: 'Starting price / min to sell (USD)' })
  startingPrice!: number;

  @ApiPropertyOptional({ example: 50, default: 50, description: 'Fixed bid increment (USD)' })
  minBidIncrement?: number;

  // 5. Duration
  @ApiProperty({ enum: [1, 3, 7, 10], example: 7, description: 'Auction duration in days' })
  durationDays!: number;

  // 6. Review — Save as Draft (true) or submit for review (false/omitted)
  @ApiPropertyOptional({ default: false, description: 'Save as draft instead of submitting' })
  saveAsDraft?: boolean;
}

// تعديل قبل الإطلاق — كل الحقول اختيارية (بدون saveAsDraft)
export class UpdateAuctionDTO {
  @ApiPropertyOptional({ enum: Category })
  category?: Category;

  @ApiPropertyOptional({ description: 'Replaces the main/cover image' })
  mainImage?: string;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the additional images (up to 10)' })
  images?: string[];

  @ApiPropertyOptional()
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  era?: string | null;

  @ApiPropertyOptional({ nullable: true })
  condition?: string | null;

  @ApiPropertyOptional({ nullable: true })
  originality?: string | null;

  @ApiPropertyOptional({ nullable: true })
  heightCm?: number | null;

  @ApiPropertyOptional({ nullable: true })
  widthCm?: number | null;

  @ApiPropertyOptional({ nullable: true })
  depthCm?: number | null;

  @ApiPropertyOptional()
  startingPrice?: number;

  @ApiPropertyOptional()
  minBidIncrement?: number;

  @ApiPropertyOptional({ enum: [1, 3, 7, 10] })
  durationDays?: number;
}

export class RejectAuctionDTO {
  @ApiProperty({ example: 'Images are too low quality to authenticate the item.' })
  reason!: string;
}

export class BrowseAuctionsQueryDTO {
  @ApiPropertyOptional({ enum: Category })
  category?: Category;

  @ApiPropertyOptional({ description: 'Keyword search on the object title' })
  q?: string;

  @ApiPropertyOptional({
    enum: ['endingSoon', 'newest', 'priceLow', 'priceHigh'],
    default: 'endingSoon',
  })
  sort?: 'endingSoon' | 'newest' | 'priceLow' | 'priceHigh';

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  limit?: number;
}

// ---- Response shapes ----
export type AuctionObject = ArtObject & { images: ObjectImage[] };
export type AuctionResponseDTO = Auction & { object: AuctionObject };
export type AuctionDetailDTO = AuctionResponseDTO & { bidCount: number };
export type PaginatedAuctionsDTO = {
  items: AuctionResponseDTO[];
  total: number;
  page: number;
  limit: number;
};
