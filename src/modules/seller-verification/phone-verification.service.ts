import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class PhoneVerificationService {
  constructor(private readonly prisma: DatabaseService) {}

  // يلغي أي محاولات غير مستهلكة لنفس المستخدم ثم ينشئ سجلاً جديداً
  async createPending(data: {
    userId: string;
    phone: string;
    codeHash: string;
    expiresAt: Date;
  }) {
    await this.prisma.phoneVerification.deleteMany({
      where: { userId: data.userId, consumedAt: null },
    });

    return this.prisma.phoneVerification.create({ data });
  }

  findLatestPending(userId: string) {
    return this.prisma.phoneVerification.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  incrementAttempts(id: string) {
    return this.prisma.phoneVerification.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  markConsumed(id: string) {
    return this.prisma.phoneVerification.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }
}
