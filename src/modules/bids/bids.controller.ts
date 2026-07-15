import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsPublic } from 'src/decorators/public.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { BidsService } from './bids.service';
import { PlaceBidDto } from './dto/bids.dto';
import type {
  AuctionBidsResponse,
  MyBidsResponse,
  PlaceBidResponse,
} from './dto/bids.dto';
import { placeBidSchema } from './util/bids.validation.schema';
import {
  SwaggerBidsTag,
  ApiPlaceBid,
  ApiAuctionBids,
  ApiMyBids,
} from 'src/swagger/bids.swagger';

@SwaggerBidsTag()
@Controller()
export class BidsController {
  constructor(private readonly bidsService: BidsService) {}

  // وضع مزايدة (محمي — أي مستخدم موثّق)
  @Post('auctions/:id/bids')
  @HttpCode(201)
  @ApiPlaceBid()
  @UsePipes(new ZodValidationPipe(placeBidSchema))
  place(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PlaceBidDto,
  ): Promise<PlaceBidResponse> {
    return this.bidsService.place(id, req.user!, dto.amount);
  }

  // سجل مزايدات المزاد (عام)
  @Get('auctions/:id/bids')
  @IsPublic(true)
  @ApiAuctionBids()
  auctionBids(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<AuctionBidsResponse> {
    return this.bidsService.getAuctionBids(
      id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  // مزايداتي (محمي)
  @Get('bids/mine')
  @ApiMyBids()
  myBids(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<MyBidsResponse> {
    return this.bidsService.getMyBids(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
