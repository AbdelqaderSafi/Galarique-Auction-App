import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import type {
  OrderDetail,
  OrderListItem,
  OrdersResponse,
} from './dto/orders.dto';
import {
  SwaggerOrdersTag,
  ApiPayOrder,
  ApiMyOrders,
  ApiMySales,
  ApiGetOrder,
} from 'src/swagger/orders.swagger';

@SwaggerOrdersTag()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ثابتة قبل :id حتى لا تُلتقط كمعرّف
  @Get('mine')
  @ApiMyOrders()
  myOrders(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<OrdersResponse> {
    return this.ordersService.getMyOrders(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('sales')
  @ApiMySales()
  mySales(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<OrdersResponse> {
    return this.ordersService.getMySales(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Post(':id/pay')
  @HttpCode(200)
  @ApiPayOrder()
  pay(@Req() req: Request, @Param('id') id: string): Promise<OrderListItem> {
    return this.ordersService.payOrder(id, req.user!.id);
  }

  @Get(':id')
  @ApiGetOrder()
  findOne(@Req() req: Request, @Param('id') id: string): Promise<OrderDetail> {
    return this.ordersService.getOrder(id, req.user!.id);
  }
}
