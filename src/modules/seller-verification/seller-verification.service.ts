import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';
import { UserService } from '../user/user.service';
import type {
  VerifyPhoneDTO,
  VerifyPhoneResponseDTO,
} from './dto/seller-verification.dto';

const PALESTINE_PREFIXES = ['+970', '+972'];

@Injectable()
export class SellerVerificationService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly firebase: FirebaseAdminService,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async verifyPhone(
    userId: string,
    dto: VerifyPhoneDTO,
  ): Promise<VerifyPhoneResponseDTO> {
    const decoded = await this.firebase.verifyIdToken(dto.idToken);
    const phone = decoded.phone_number;

    if (!phone) {
      throw new BadRequestException(
        'The Firebase token does not contain a phone number.',
      );
    }

    if (!PALESTINE_PREFIXES.some((prefix) => phone.startsWith(prefix))) {
      throw new BadRequestException(
        'Phone number must be a Palestinian number (+970 or +972).',
      );
    }

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      // الرقم محجوز لمستخدم آخر؟
      const phoneOwner = await tx.user.findUnique({ where: { phone } });
      if (phoneOwner && phoneOwner.id !== userId) {
        throw new ConflictException(
          'This phone number is already registered to another account.',
        );
      }

      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
      });

      const roles = current.roles.includes(Role.SELLER)
        ? current.roles
        : [...current.roles, Role.SELLER];

      const user = await tx.user.update({
        where: { id: userId },
        data: { phone, isPhoneVerified: true, roles },
      });

      // upsert حتى يدعم إعادة التوثيق دون خطأ
      await tx.sellerProfile.upsert({
        where: { userId },
        create: { userId, phoneNumber: phone, phoneVerifiedAt: new Date() },
        update: { phoneNumber: phone, phoneVerifiedAt: new Date() },
      });

      return user;
    });

    // توكن جديد يحمل دور SELLER المُحدَّث
    const token = this.jwtService.sign(
      { sub: updatedUser.id, roles: updatedUser.roles },
      { expiresIn: '30d' },
    );

    return {
      token,
      userData: this.userService.mapUserWithoutPassword(updatedUser),
    };
  }
}
