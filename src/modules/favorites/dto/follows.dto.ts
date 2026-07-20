import { ApiPropertyOptional } from '@nestjs/swagger';

// ===== Query DTO (pagination) =====

export class FollowsQueryDTO {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  limit?: number;
}

// ===== Response shapes =====

export type ToggleFollowResponse = {
  following: boolean;
};

export type FollowedSellerItem = {
  id: string; // sellerId
  fullName: string;
  followedAt: Date;
};

export type FollowsResponse = {
  items: FollowedSellerItem[];
  page: number;
  limit: number;
  total: number;
};
