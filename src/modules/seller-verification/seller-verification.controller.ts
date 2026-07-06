import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { Role } from 'generated/prisma/client';
import { Roles } from 'src/decorators/roles.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { SellerVerificationService } from './seller-verification.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  RequestVerificationDTO,
  SellerMessageResponseDTO,
  VerifyPhoneDTO,
} from './dto/seller-verification.dto';
import {
  requestVerificationSchema,
  verifyPhoneSchema,
} from './util/seller-verification.validation.schema';
import {
  SwaggerSellerTag,
  ApiRequestVerification,
  ApiVerifyPhone,
  ApiResendPhoneCode,
  ApiWhatsappStatus,
} from 'src/swagger/seller-verification.swagger';

@SwaggerSellerTag()
@Controller('seller')
export class SellerVerificationController {
  constructor(
    private readonly sellerVerificationService: SellerVerificationService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Post('request-verification')
  @HttpCode(200)
  @ApiRequestVerification()
  @UsePipes(new ZodValidationPipe(requestVerificationSchema))
  requestVerification(
    @Req() req: Request,
    @Body() dto: RequestVerificationDTO,
  ): Promise<SellerMessageResponseDTO> {
    return this.sellerVerificationService.requestVerification(req.user!.id, dto);
  }

  @Post('verify-phone')
  @HttpCode(200)
  @ApiVerifyPhone()
  @UsePipes(new ZodValidationPipe(verifyPhoneSchema))
  verifyPhone(
    @Req() req: Request,
    @Body() dto: VerifyPhoneDTO,
  ): Promise<SellerMessageResponseDTO> {
    return this.sellerVerificationService.verifyPhone(req.user!.id, dto);
  }

  @Post('resend')
  @HttpCode(200)
  @ApiResendPhoneCode()
  resend(@Req() req: Request): Promise<SellerMessageResponseDTO> {
    return this.sellerVerificationService.resend(req.user!.id);
  }

  // للأدمن: حالة اتصال واتساب + الـ QR للربط الأولي
  @Get('whatsapp/status')
  @Roles([Role.ADMIN])
  @ApiWhatsappStatus()
  whatsappStatus(): { connected: boolean; qr: string | null } {
    return { connected: this.whatsapp.isReady(), qr: this.whatsapp.getQr() };
  }
}
