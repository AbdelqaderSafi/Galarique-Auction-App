import { Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FavoritesService } from './favorites.service';
import type { FavoriteAuctionsResponse, ToggleFavoriteResponse } from './dto/favorites.dto';
import {
  SwaggerFavoritesTag,
  ApiAddFavoriteAuction,
  ApiRemoveFavoriteAuction,
  ApiListFavoriteAuctions,
} from 'src/swagger/favorites.swagger';

@SwaggerFavoritesTag()
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Post(':auctionId')
  @ApiAddFavoriteAuction()
  add(
    @Req() req: Request,
    @Param('auctionId') auctionId: string,
  ): Promise<ToggleFavoriteResponse> {
    return this.favoritesService.add(req.user!.id, auctionId);
  }

  @Delete(':auctionId')
  @ApiRemoveFavoriteAuction()
  remove(
    @Req() req: Request,
    @Param('auctionId') auctionId: string,
  ): Promise<ToggleFavoriteResponse> {
    return this.favoritesService.remove(req.user!.id, auctionId);
  }

  @Get()
  @ApiListFavoriteAuctions()
  list(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<FavoriteAuctionsResponse> {
    return this.favoritesService.list(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
