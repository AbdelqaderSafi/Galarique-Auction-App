import { ConflictException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { UserService } from './user.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('UserService', () => {
  let prisma: MockDatabaseService;
  let service: UserService;

  beforeEach(() => {
    prisma = createMockDatabaseService();
    service = new UserService(prisma);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('rejects a duplicate email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' } as any);
      await expect(
        service.create({ fullName: 'A', email: 'a@b.com', password: 'hashed' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('mapUserWithoutPassword', () => {
    it('strips the password field', () => {
      const result = service.mapUserWithoutPassword({
        id: 'u1',
        email: 'a@b.com',
        password: 'super-secret-hash',
      } as any);
      expect(result).not.toHaveProperty('password');
      expect(result).toEqual({ id: 'u1', email: 'a@b.com' });
    });
  });

  describe('updateProfile', () => {
    it('maps a Prisma unique-constraint violation (duplicate username) to 409', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '7.0.0',
        }),
      );

      await expect(
        service.updateProfile('u1', { username: 'taken' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('re-throws any other error unchanged', async () => {
      prisma.user.update.mockRejectedValue(new Error('db down'));
      await expect(
        service.updateProfile('u1', { username: 'free' } as any),
      ).rejects.toThrow('db down');
    });

    it('updates and returns the user without the password on success', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        username: 'newname',
        password: 'hash',
      } as any);

      const result = await service.updateProfile('u1', { username: 'newname' } as any);

      expect(result).not.toHaveProperty('password');
      expect(result.username).toBe('newname');
    });
  });
});
