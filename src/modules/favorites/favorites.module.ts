import { Module } from '@nestjs/common';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';
import { FollowsController } from './follows.controller';
import { FollowsService } from './follows.service';

@Module({
  controllers: [FavoritesController, FollowsController],
  providers: [FavoritesService, FollowsService],
})
export class FavoritesModule {}
