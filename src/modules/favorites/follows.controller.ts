import { Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FollowsService } from './follows.service';
import type { FollowsResponse, ToggleFollowResponse } from './dto/follows.dto';
import {
  SwaggerFollowsTag,
  ApiFollowSeller,
  ApiUnfollowSeller,
  ApiListFollowing,
} from 'src/swagger/follows.swagger';

@SwaggerFollowsTag()
@Controller('follows')
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  @Post(':sellerId')
  @ApiFollowSeller()
  follow(
    @Req() req: Request,
    @Param('sellerId') sellerId: string,
  ): Promise<ToggleFollowResponse> {
    return this.followsService.follow(req.user!.id, sellerId);
  }

  @Delete(':sellerId')
  @ApiUnfollowSeller()
  unfollow(
    @Req() req: Request,
    @Param('sellerId') sellerId: string,
  ): Promise<ToggleFollowResponse> {
    return this.followsService.unfollow(req.user!.id, sellerId);
  }

  @Get()
  @ApiListFollowing()
  listFollowing(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<FollowsResponse> {
    return this.followsService.listFollowing(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
