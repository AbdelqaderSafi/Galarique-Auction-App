import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as argon from 'argon2';
import { AuthProvider, Role } from 'generated/prisma/client';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { EmailVerificationService } from './email-verification.service';
import { PasswordResetService } from './password-reset.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

describe('AuthService', () => {
  let userService: jest.Mocked<UserService>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let mailService: jest.Mocked<MailService>;
  let emailVerificationService: jest.Mocked<EmailVerificationService>;
  let passwordResetService: jest.Mocked<PasswordResetService>;
  let service: AuthService;

  beforeEach(() => {
    userService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      updatePassword: jest.fn(),
      mapUserWithoutPassword: jest.fn((u: any) => {
        const { password, ...rest } = u ?? {};
        return rest;
      }),
    } as unknown as jest.Mocked<UserService>;
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') } as unknown as jest.Mocked<JwtService>;
    configService = {
      get: jest.fn((key: string) => (key === 'OTP_EXP_MINUTES' ? '5' : key === 'OTP_MAX_ATTEMPTS' ? '5' : undefined)),
      getOrThrow: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;
    mailService = {
      sendEmailVerificationCode: jest.fn(),
      sendPasswordResetCode: jest.fn(),
    } as unknown as jest.Mocked<MailService>;
    emailVerificationService = {
      createPending: jest.fn(),
      findLatestPending: jest.fn(),
      incrementAttempts: jest.fn(),
      markConsumed: jest.fn(),
    } as unknown as jest.Mocked<EmailVerificationService>;
    passwordResetService = {
      createPending: jest.fn(),
      findLatestPending: jest.fn(),
      incrementAttempts: jest.fn(),
      markConsumed: jest.fn(),
    } as unknown as jest.Mocked<PasswordResetService>;

    service = new AuthService(
      userService,
      jwtService,
      configService,
      mailService,
      emailVerificationService,
      passwordResetService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('register', () => {
    it('rejects when the email is already registered', async () => {
      userService.findByEmail.mockResolvedValue({ id: 'u1' } as any);

      await expect(
        service.register({ email: 'a@b.com', password: 'Pass1234!', fullName: 'A' } as any),
      ).rejects.toThrow(ConflictException);
      expect(emailVerificationService.createPending).not.toHaveBeenCalled();
    });

    it('creates a pending signup and emails a 6-digit code (does NOT create the User yet)', async () => {
      userService.findByEmail.mockResolvedValue(null);

      const result = await service.register({
        email: 'a@b.com',
        password: 'Pass1234!',
        fullName: 'A',
      } as any);

      expect(userService.create).not.toHaveBeenCalled();
      expect(emailVerificationService.createPending).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'a@b.com', fullName: 'A' }),
      );
      const sentCode = mailService.sendEmailVerificationCode.mock.calls[0][2];
      expect(sentCode).toMatch(/^\d{6}$/);
      expect(result.message).toMatch(/verification code/i);
    });
  });

  describe('verifyEmail', () => {
    it('throws 404 when there is no pending verification', async () => {
      emailVerificationService.findLatestPending.mockResolvedValue(null);
      await expect(
        service.verifyEmail({ email: 'a@b.com', code: '123456' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 400 after too many attempts', async () => {
      emailVerificationService.findLatestPending.mockResolvedValue({
        id: 'ev1',
        attempts: 5,
        expiresAt: new Date(Date.now() + 60000),
        codeHash: 'x',
        email: 'a@b.com',
      } as any);
      await expect(
        service.verifyEmail({ email: 'a@b.com', code: '123456' } as any),
      ).rejects.toThrow('Too many attempts');
    });

    it('throws 400 when the code has expired', async () => {
      emailVerificationService.findLatestPending.mockResolvedValue({
        id: 'ev1',
        attempts: 0,
        expiresAt: new Date(Date.now() - 1000),
        codeHash: 'x',
        email: 'a@b.com',
      } as any);
      await expect(
        service.verifyEmail({ email: 'a@b.com', code: '123456' } as any),
      ).rejects.toThrow('expired');
    });

    it('throws 400 and increments attempts on a wrong code', async () => {
      const codeHash = await argon.hash('999999');
      emailVerificationService.findLatestPending.mockResolvedValue({
        id: 'ev1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        email: 'a@b.com',
      } as any);

      await expect(
        service.verifyEmail({ email: 'a@b.com', code: '111111' } as any),
      ).rejects.toThrow('Invalid verification code');
      expect(emailVerificationService.incrementAttempts).toHaveBeenCalledWith('ev1');
    });

    it('rejects (race condition) if the email got registered between register() and verifyEmail()', async () => {
      const codeHash = await argon.hash('123456');
      emailVerificationService.findLatestPending.mockResolvedValue({
        id: 'ev1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        email: 'a@b.com',
        fullName: 'A',
        password: 'hashed-pw',
      } as any);
      userService.findByEmail.mockResolvedValue({ id: 'existing' } as any);

      await expect(
        service.verifyEmail({ email: 'a@b.com', code: '123456' } as any),
      ).rejects.toThrow(ConflictException);
      expect(emailVerificationService.markConsumed).toHaveBeenCalledWith('ev1');
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('creates the User and returns a JWT on a valid code', async () => {
      const codeHash = await argon.hash('123456');
      emailVerificationService.findLatestPending.mockResolvedValue({
        id: 'ev1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
        codeHash,
        email: 'a@b.com',
        fullName: 'A',
        password: 'hashed-pw',
      } as any);
      userService.findByEmail.mockResolvedValue(null);
      userService.create.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        fullName: 'A',
        roles: [Role.BUYER],
        password: 'hashed-pw',
      } as any);

      const result = await service.verifyEmail({ email: 'a@b.com', code: '123456' } as any);

      expect(userService.create).toHaveBeenCalledWith({
        fullName: 'A',
        email: 'a@b.com',
        password: 'hashed-pw',
        provider: AuthProvider.LOCAL,
      });
      expect(emailVerificationService.markConsumed).toHaveBeenCalledWith('ev1');
      expect(result.token).toBe('signed.jwt.token');
      expect(jwtService.sign).toHaveBeenCalledWith({ sub: 'u1', roles: [Role.BUYER] }, { expiresIn: '30d' });
    });
  });

  describe('login', () => {
    it('rejects an unknown email with a generic 401 (no user enumeration)', async () => {
      userService.findByEmail.mockResolvedValue(null);
      await expect(
        service.login({ email: 'a@b.com', password: 'x' } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a social-login account (no password set)', async () => {
      userService.findByEmail.mockResolvedValue({ id: 'u1', password: null } as any);
      await expect(
        service.login({ email: 'a@b.com', password: 'x' } as any),
      ).rejects.toThrow(/social login/);
    });

    it('rejects a wrong password', async () => {
      const hashed = await argon.hash('correct-password');
      userService.findByEmail.mockResolvedValue({ id: 'u1', password: hashed, roles: [Role.BUYER] } as any);
      await expect(
        service.login({ email: 'a@b.com', password: 'wrong-password' } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns a JWT on correct credentials', async () => {
      const hashed = await argon.hash('correct-password');
      userService.findByEmail.mockResolvedValue({
        id: 'u1',
        password: hashed,
        roles: [Role.BUYER],
        email: 'a@b.com',
      } as any);

      const result = await service.login({ email: 'a@b.com', password: 'correct-password' } as any);

      expect(result.token).toBe('signed.jwt.token');
    });
  });

  describe('forgotPassword', () => {
    it('returns the same generic message whether or not the email exists (no enumeration)', async () => {
      userService.findByEmail.mockResolvedValueOnce(null);
      const r1 = await service.forgotPassword({ email: 'unknown@b.com' } as any);

      userService.findByEmail.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', fullName: 'A' } as any);
      const r2 = await service.forgotPassword({ email: 'a@b.com' } as any);

      expect(r1.message).toBe(r2.message);
      expect(passwordResetService.createPending).toHaveBeenCalledTimes(1); // only for the real user
    });
  });

  describe('changePassword', () => {
    it('rejects when the current password is wrong', async () => {
      const hashed = await argon.hash('current-pw');
      userService.findById.mockResolvedValue({ id: 'u1', password: hashed } as any);

      await expect(
        service.changePassword('u1', { currentPassword: 'wrong', newPassword: 'New1234!' } as any),
      ).rejects.toThrow('Current password is incorrect');
    });

    it('rejects when newPassword equals currentPassword', async () => {
      const hashed = await argon.hash('same-pw');
      userService.findById.mockResolvedValue({ id: 'u1', password: hashed } as any);

      await expect(
        service.changePassword('u1', { currentPassword: 'same-pw', newPassword: 'same-pw' } as any),
      ).rejects.toThrow('must be different');
    });

    it('updates the password on valid input', async () => {
      const hashed = await argon.hash('current-pw');
      userService.findById.mockResolvedValue({ id: 'u1', password: hashed } as any);

      const result = await service.changePassword('u1', {
        currentPassword: 'current-pw',
        newPassword: 'New1234!',
      } as any);

      expect(userService.updatePassword).toHaveBeenCalledWith('u1', expect.any(String));
      expect(result.message).toMatch(/changed successfully/);
    });
  });
});
