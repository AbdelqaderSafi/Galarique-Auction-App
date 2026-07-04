import { Body, Controller, Post, Req, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { SellerVerificationService } from './seller-verification.service';
import type {
  VerifyPhoneDTO,
  VerifyPhoneResponseDTO,
} from './dto/seller-verification.dto';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { verifyPhoneSchema } from './util/seller-verification.validation.schema';
import {
  SwaggerSellerTag,
  ApiVerifyPhone,
} from 'src/swagger/seller-verification.swagger';

@SwaggerSellerTag()
@Controller('seller')
export class SellerVerificationController {
  constructor(
    private readonly sellerVerificationService: SellerVerificationService,
  ) {}

  @Post('verify-phone')
  @ApiVerifyPhone()
  @UsePipes(new ZodValidationPipe(verifyPhoneSchema))
  verifyPhone(
    @Req() req: Request,
    @Body() dto: VerifyPhoneDTO,
  ): Promise<VerifyPhoneResponseDTO> {
    return this.sellerVerificationService.verifyPhone(req.user!.id, dto);
  }
}
