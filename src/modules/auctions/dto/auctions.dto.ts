import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Category } from 'generated/prisma/client';
import type {
  Auction,
  Object as ArtObject,
  ObjectImage,
} from 'generated/prisma/client';

export class CreateAuctionDTO {
  @ApiProperty({
    format: 'uuid',
    description: 'Id of an AVAILABLE object the seller owns',
    example: '3f1c2b7e-0a1d-4c9a-9f2e-8b7a6c5d4e3f',
  })
  objectId!: string;

  @ApiProperty({ example: 1000, description: 'Opening price (USD)' })
  startingPrice!: number;

  @ApiPropertyOptional({
    example: 1500,
    description: 'Reserve price (>= startingPrice); hidden from buyers',
  })
  reservePrice?: number;

  @ApiPropertyOptional({
    example: 50,
    default: 50,
    description: 'Minimum bid increment (USD)',
  })
  minBidIncrement?: number;

  @ApiProperty({
    enum: [3, 5, 7, 10],
    example: 7,
    description: 'Auction duration in days (starts on admin approval)',
  })
  durationDays!: number;
}

export class UpdateAuctionDTO {
  @ApiPropertyOptional({ example: 1000 })
  startingPrice?: number;

  @ApiPropertyOptional({
    example: 1500,
    nullable: true,
    description: 'Send null to clear the reserve price',
  })
  reservePrice?: number | null;

  @ApiPropertyOptional({ example: 50 })
  minBidIncrement?: number;

  @ApiPropertyOptional({ enum: [3, 5, 7, 10], example: 5 })
  durationDays?: number;
}

export class RejectAuctionDTO {
  @ApiProperty({
    example: 'Images are too low quality to authenticate the item.',
    description: 'Reason shown to the seller',
  })
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
