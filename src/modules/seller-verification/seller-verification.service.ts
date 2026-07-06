import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon from 'argon2';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { EnvVariables } from 'src/types/declartion-mergin';
import { Role } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PhoneVerificationService } from './phone-verification.service';
import { normalizePalestinianPhone } from './util/phone.util';
import type {
  RequestVerificationDTO,
  SellerMessageResponseDTO,
  VerifyPhoneDTO,
} from './dto/seller-verification.dto';

@Injectable()
export class SellerVerificationService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly whatsapp: WhatsappService,
    private readonly phoneVerificationService: PhoneVerificationService,
    private readonly config: ConfigService<EnvVariables>,
  ) {}

  // الخطوة 1: يتحقّق أن الرقم فلسطيني، يولّد رمزاً ويرسله عبر واتساب
  async requestVerification(
    userId: string,
    dto: RequestVerificationDTO,
  ): Promise<SellerMessageResponseDTO> {
    const phone = normalizePalestinianPhone(dto.phoneNumber);
    if (!phone) {
      throw new BadRequestException(
        'Enter a valid Palestinian mobile number (+970 / +972).',
      );
    }

    const existingProfile = await this.prisma.sellerProfile.findUnique({
      where: { userId },
    });
    if (existingProfile) {
      throw new ConflictException('You are already a verified seller.');
    }

    const phoneTaken = await this.prisma.sellerProfile.findUnique({
      where: { phoneNumber: phone },
    });
    if (phoneTaken) {
      throw new ConflictException(
        'This phone number is already linked to another seller.',
      );
    }

    const code = this.generateOtpCode();
    const codeHash = await argon.hash(code);
    const expiresAt = new Date(Date.now() + this.otpExpiryMs());

    await this.phoneVerificationService.createPending({
      userId,
      phone,
      codeHash,
      expiresAt,
    });
    await this.whatsapp.sendOtp(phone, code);

    return { message: 'A verification code has been sent to your WhatsApp.' };
  }

  // الخطوة 2: يتحقّق من الرمز، وعند النجاح ينشئ SellerProfile ويمنح دور SELLER
  async verifyPhone(
    userId: string,
    dto: VerifyPhoneDTO,
  ): Promise<SellerMessageResponseDTO> {
    const pending = await this.phoneVerificationService.findLatestPending(userId);
    if (!pending) {
      throw new NotFoundException(
        'No pending phone verification. Request a code first.',
      );
    }

    if (pending.attempts >= this.otpMaxAttempts()) {
      throw new BadRequestException('Too many attempts. Request a new code.');
    }

    if (pending.expiresAt < new Date()) {
      throw new BadRequestException('The code has expired. Request a new one.');
    }

    const isValid = await argon.verify(pending.codeHash, dto.code);
    if (!isValid) {
      await this.phoneVerificationService.incrementAttempts(pending.id);
      throw new BadRequestException('Invalid verification code.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sellerProfile.create({
        data: {
          userId,
          phoneNumber: pending.phone,
          phoneVerifiedAt: new Date(),
        },
      });

      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const roles = Array.from(new Set([...user.roles, Role.SELLER]));
      await tx.user.update({ where: { id: userId }, data: { roles } });
    });

    await this.phoneVerificationService.markConsumed(pending.id);

    return { message: 'Your phone is verified — you are now a seller.' };
  }

  // إعادة إرسال رمز جديد لنفس الرقم المعلّق
  async resend(userId: string): Promise<SellerMessageResponseDTO> {
    const pending = await this.phoneVerificationService.findLatestPending(userId);
    if (!pending) {
      throw new NotFoundException(
        'No pending phone verification. Request a code first.',
      );
    }

    const code = this.generateOtpCode();
    const codeHash = await argon.hash(code);
    const expiresAt = new Date(Date.now() + this.otpExpiryMs());

    await this.phoneVerificationService.createPending({
      userId,
      phone: pending.phone,
      codeHash,
      expiresAt,
    });
    await this.whatsapp.sendOtp(pending.phone, code);

    return {
      message: 'A new verification code has been sent to your WhatsApp.',
    };
  }

  // رمز عشوائي من 6 أرقام (آمن تشفيرياً)
  private generateOtpCode(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private otpExpiryMs(): number {
    const minutes = Number(this.config.get<string>('OTP_EXP_MINUTES'));
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60 * 1000;
  }

  private otpMaxAttempts(): number {
    const attempts = Number(this.config.get<string>('OTP_MAX_ATTEMPTS'));
    return Number.isFinite(attempts) && attempts > 0 ? attempts : 5;
  }
}
