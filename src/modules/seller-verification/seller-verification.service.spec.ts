import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as argon from 'argon2';
import { Role } from 'generated/prisma/client';
import { SellerVerificationService } from './seller-verification.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PhoneVerificationService } from './phone-verification.service';
import { ConfigService } from '@nestjs/config';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('SellerVerificationService', () => {
  let prisma: MockDatabaseService;
  let whatsapp: jest.Mocked<WhatsappService>;
  let phoneVerification: jest.Mocked<PhoneVerificationService>;
  let config: jest.Mocked<ConfigService>;
  let service: SellerVerificationService;
  const userId = 'user-1';

  beforeEach(() => {
    prisma = createMockDatabaseService();
    whatsapp = { sendOtp: jest.fn() } as unknown as jest.Mocked<WhatsappService>;
    phoneVerification = {
      createPending: jest.fn(),
      findLatestPending: jest.fn(),
      incrementAttempts: jest.fn(),
      markConsumed: jest.fn(),
    } as unknown as jest.Mocked<PhoneVerificationService>;
    config = { get: jest.fn().mockReturnValue(undefined) } as unknown as jest.Mocked<ConfigService>;
    service = new SellerVerificationService(prisma, whatsapp, phoneVerification, config);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('requestVerification', () => {
    it('rejects a non-Palestinian phone number', async () => {
      await expect(
        service.requestVerification(userId, { phoneNumber: '+1 555 0100' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.sellerProfile.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a user who is already a verified seller', async () => {
      prisma.sellerProfile.findUnique.mockResolvedValueOnce({ id: 'sp1' } as any);
      await expect(
        service.requestVerification(userId, { phoneNumber: '0599123456' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a phone number already linked to another seller', async () => {
      prisma.sellerProfile.findUnique
        .mockResolvedValueOnce(null) // own profile check
        .mockResolvedValueOnce({ id: 'sp2' } as any); // phone taken check
      await expect(
        service.requestVerification(userId, { phoneNumber: '0599123456' } as any),
      ).rejects.toThrow('already linked to another seller');
    });

    it('sends the OTP via WhatsApp by default (not simulate mode)', async () => {
      prisma.sellerProfile.findUnique.mockResolvedValue(null);

      const result = await service.requestVerification(userId, { phoneNumber: '0599123456' } as any);

      expect(whatsapp.sendOtp).toHaveBeenCalledWith('970599123456', expect.stringMatching(/^\d{6}$/));
      expect(result).toEqual({ message: 'A verification code has been sent to your WhatsApp.' });
      expect((result as any).code).toBeUndefined();
    });

    it('returns the code in the response and skips WhatsApp when SELLER_OTP_SIMULATE=true', async () => {
      config.get.mockImplementation((key: string) => (key === 'SELLER_OTP_SIMULATE' ? 'true' : undefined));
      prisma.sellerProfile.findUnique.mockResolvedValue(null);

      const result = await service.requestVerification(userId, { phoneNumber: '0599123456' } as any);

      expect(whatsapp.sendOtp).not.toHaveBeenCalled();
      expect((result as any).code).toMatch(/^\d{6}$/);
    });
  });

  describe('verifyPhone', () => {
    it('throws 404 when there is no pending verification', async () => {
      phoneVerification.findLatestPending.mockResolvedValue(null);
      await expect(service.verifyPhone(userId, { code: '123456' } as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 400 after too many attempts', async () => {
      phoneVerification.findLatestPending.mockResolvedValue({
        id: 'pv1',
        attempts: 5,
        expiresAt: new Date(Date.now() + 60000),
        codeHash: 'x',
        phone: '970599123456',
      } as any);
      await expect(service.verifyPhone(userId, { code: '123456' } as any)).rejects.toThrow(
        'Too many attempts',
      );
    });

    it('throws 400 and increments attempts on a wrong code', async () => {
      const codeHash = await argon.hash('999999');
      phoneVerification.findLatestPending.mockResolvedValue({
        id: 'pv1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        phone: '970599123456',
      } as any);

      await expect(service.verifyPhone(userId, { code: '111111' } as any)).rejects.toThrow(
        'Invalid verification code',
      );
      expect(phoneVerification.incrementAttempts).toHaveBeenCalledWith('pv1');
    });

    it('creates the SellerProfile and grants the SELLER role on a valid code', async () => {
      const codeHash = await argon.hash('123456');
      phoneVerification.findLatestPending.mockResolvedValue({
        id: 'pv1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        phone: '970599123456',
      } as any);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, roles: [Role.BUYER] } as any);

      const result = await service.verifyPhone(userId, { code: '123456' } as any);

      expect(prisma.sellerProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId, phoneNumber: '970599123456' }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { roles: [Role.BUYER, Role.SELLER] },
      });
      expect(phoneVerification.markConsumed).toHaveBeenCalledWith('pv1');
      expect(result.message).toMatch(/now a seller/);
    });

    it('never grants SELLER twice (roles stay deduplicated) if already a seller', async () => {
      const codeHash = await argon.hash('123456');
      phoneVerification.findLatestPending.mockResolvedValue({
        id: 'pv1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        phone: '970599123456',
      } as any);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, roles: [Role.BUYER, Role.SELLER] } as any);

      await service.verifyPhone(userId, { code: '123456' } as any);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { roles: [Role.BUYER, Role.SELLER] },
      });
    });
  });
});
