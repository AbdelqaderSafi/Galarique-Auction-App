import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class EmailVerificationService {
  constructor(private readonly prisma: DatabaseService) {}

  // يستبدل أي محاولات سابقة غير مستهلكة لنفس الإيميل ثم ينشئ سجلاً جديداً
  async createPending(data: {
    email: string;
    fullName: string;
    hashedPassword: string;
    codeHash: string;
    expiresAt: Date;
  }) {
    await this.prisma.emailVerification.deleteMany({
      where: { email: data.email, consumedAt: null },
    });

    return this.prisma.emailVerification.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        password: data.hashedPassword,
        codeHash: data.codeHash,
        expiresAt: data.expiresAt,
      },
    });
  }

  findLatestPending(email: string) {
    return this.prisma.emailVerification.findFirst({
      where: { email, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  incrementAttempts(id: string) {
    return this.prisma.emailVerification.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  markConsumed(id: string) {
    return this.prisma.emailVerification.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }
}
