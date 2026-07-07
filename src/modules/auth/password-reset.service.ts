import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class PasswordResetService {
  constructor(private readonly prisma: DatabaseService) {}

  // يلغي أي أكواد غير مستهلكة لنفس المستخدم ثم ينشئ سجلاً جديداً
  async createPending(data: {
    userId: string;
    codeHash: string;
    expiresAt: Date;
  }) {
    await this.prisma.passwordReset.deleteMany({
      where: { userId: data.userId, consumedAt: null },
    });

    return this.prisma.passwordReset.create({ data });
  }

  findLatestPending(userId: string) {
    return this.prisma.passwordReset.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  incrementAttempts(id: string) {
    return this.prisma.passwordReset.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  markConsumed(id: string) {
    return this.prisma.passwordReset.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }
}
