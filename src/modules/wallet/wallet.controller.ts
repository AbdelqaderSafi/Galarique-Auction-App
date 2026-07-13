import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UsePipes,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsPublic } from 'src/decorators/public.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { WalletService } from './wallet.service';
import { TopUpDto, WithdrawDto } from './dto/wallet.dto';
import type {
  CheckoutResponse,
  ConnectLinkResponse,
  ConnectStatusResponse,
  TopUpStatusResponse,
  TransactionsResponse,
  WalletResponse,
  WebhookResponse,
  WithdrawResponse,
} from './dto/wallet.dto';
import { topupSchema, withdrawSchema } from './util/wallet.validation.schema';
import {
  SwaggerWalletTag,
  ApiGetWallet,
  ApiGetTransactions,
  ApiTopUp,
  ApiTopUpStatus,
  ApiStripeWebhook,
  ApiConnectOnboard,
  ApiConnectStatus,
  ApiWithdraw,
} from 'src/swagger/wallet.swagger';

@SwaggerWalletTag()
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiGetWallet()
  getWallet(@Req() req: Request): Promise<WalletResponse> {
    return this.walletService.getWallet(req.user!.id);
  }

  @Get('transactions')
  @ApiGetTransactions()
  getTransactions(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<TransactionsResponse> {
    return this.walletService.getTransactions(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('topup')
  @ApiTopUp()
  @UsePipes(new ZodValidationPipe(topupSchema))
  topup(
    @Req() req: Request,
    @Body() dto: TopUpDto,
  ): Promise<CheckoutResponse> {
    return this.walletService.createTopUp(req.user!.id, dto.amount);
  }

  // للموبايل بعد الرجوع من صفحة الدفع — يتحقّق من حالة الجلسة (paid/credited)
  @Get('topup/status')
  @ApiTopUpStatus()
  topupStatus(
    @Req() req: Request,
    @Query('session_id') sessionId?: string,
  ): Promise<TopUpStatusResponse> {
    if (!sessionId) {
      throw new BadRequestException('session_id query param is required.');
    }
    return this.walletService.getTopUpStatus(req.user!.id, sessionId);
  }

  // عام — Stripe ينادينا بدون JWT؛ الأمان عبر توقيع Stripe والـ raw body
  @Post('stripe/webhook')
  @IsPublic(true)
  @HttpCode(200)
  @ApiStripeWebhook()
  stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<WebhookResponse> {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw body for webhook.');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header.');
    }
    return this.walletService.handleWebhook(req.rawBody, signature);
  }

  @Post('connect/onboard')
  @ApiConnectOnboard()
  connectOnboard(@Req() req: Request): Promise<ConnectLinkResponse> {
    return this.walletService.connectOnboard(req.user!.id);
  }

  @Get('connect/status')
  @ApiConnectStatus()
  connectStatus(@Req() req: Request): Promise<ConnectStatusResponse> {
    return this.walletService.connectStatus(req.user!.id);
  }

  @Post('withdraw')
  @ApiWithdraw()
  @UsePipes(new ZodValidationPipe(withdrawSchema))
  withdraw(
    @Req() req: Request,
    @Body() dto: WithdrawDto,
  ): Promise<WithdrawResponse> {
    return this.walletService.requestWithdrawal(req.user!.id, dto.amount);
  }
}
