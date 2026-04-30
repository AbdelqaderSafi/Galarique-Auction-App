import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthProvider, Role } from 'generated/prisma/client';
import { removeFields } from '../utils/object.util';
import type { UserResponseDTO } from '../auth/dto/auth.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: DatabaseService) {}

  async create(data: {
    fullName: string;
    email: string;
    password: string | null;
    provider?: AuthProvider;
    providerId?: string | null;
    roles?: Role[];
  }) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    return this.prisma.user.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        password: data.password,
        provider: data.provider ?? AuthProvider.LOCAL,
        providerId: data.providerId ?? null,
        roles: data.roles ?? [Role.BUYER],
      },
    });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  mapUserWithoutPassword(
    user: Awaited<ReturnType<typeof this.findByEmail>>,
  ): UserResponseDTO['userData'] {
    return removeFields(user!, ['password']);
  }
}
