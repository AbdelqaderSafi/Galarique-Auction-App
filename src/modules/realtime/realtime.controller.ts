import {
  Controller,
  MessageEvent,
  NotFoundException,
  Param,
  Req,
  Sse,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { RealtimeService } from './realtime.service';
import { DatabaseService } from '../database/database.service';
import { PUBLIC_STATUSES } from '../auctions/auctions.service';
import {
  SwaggerRealtimeTag,
  ApiAuctionStream,
  ApiMeStream,
} from 'src/swagger/realtime.swagger';

@SwaggerRealtimeTag()
@Controller()
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: DatabaseService,
  ) {}

  // تدفق أحداث مزاد معيّن (محمي — أي مستخدم موثّق)
  @Sse('auctions/:id/stream')
  @ApiAuctionStream()
  async auctionStream(
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!auction || !PUBLIC_STATUSES.includes(auction.status)) {
      throw new NotFoundException('Auction not found');
    }
    return this.realtime.auctionStream(id);
  }

  // تدفق إشعاراتي الشخصية (محمي)
  @Sse('me/stream')
  @ApiMeStream()
  meStream(@Req() req: Request): Observable<MessageEvent> {
    return this.realtime.userStream(req.user!.id);
  }
}
