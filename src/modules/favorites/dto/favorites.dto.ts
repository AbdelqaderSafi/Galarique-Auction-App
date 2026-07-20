import { ApiPropertyOptional } from '@nestjs/swagger';
import type { AuctionStatus } from 'generated/prisma/client';

// ===== Query DTO (pagination) =====

export class FavoritesQueryDTO {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  limit?: number;
}

// ===== Response shapes =====

export type ToggleFavoriteResponse = {
  favorited: boolean;
};

export type FavoriteAuctionItem = {
  id: string; // auctionId
  title: string;
  mainImage: string;
  status: AuctionStatus;
  currentPrice: string;
  startingPrice: string;
  endTime: Date | null;
  favoritedAt: Date;
};

export type FavoriteAuctionsResponse = {
  items: FavoriteAuctionItem[];
  page: number;
  limit: number;
  total: number;
};
