import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ForgotPasswordDTO,
  GoogleAuthDTO,
  LoginDTO,
  MessageResponseDTO,
  RegisterDTO,
  ResetPasswordDTO,
  UserResponseDTO,
  VerifyEmailDTO,
} from './dto/auth.dto';
import * as argon from 'argon2';
import * as crypto from 'crypto';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { EmailVerificationService } from './email-verification.service';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Role } from 'generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { EnvVariables } from 'src/types/declartion-mergin';
import { OAuth2Client } from 'google-auth-library';

// رسالة موحّدة لا تكشف ما إذا كان الإيميل مسجّلاً أم لا
const GENERIC_RESET_MESSAGE =
  'If this email exists, a reset link has been sent.';

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private configService: ConfigService<EnvVariables>,
    private mailService: MailService,
    private emailVerificationService: EmailVerificationService,
  ) {}

  // الخطوة 1: لا نُنشئ اليوزر بعد — نبعث رمز تأكيد للإيميل ونخزّن البيانات مؤقتاً
  async register(registerDTO: RegisterDTO): Promise<MessageResponseDTO> {
    const existingUser = await this.userService.findByEmail(registerDTO.email);
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const hashedPassword = await this.hashPassword(registerDTO.password);
    const code = this.generateOtpCode();
    const codeHash = await this.hashPassword(code);
    const expiresAt = new Date(Date.now() + this.otpExpiryMs());

    await this.emailVerificationService.createPending({
      email: registerDTO.email,
      fullName: registerDTO.fullName,
      hashedPassword,
      codeHash,
      expiresAt,
    });

    await this.mailService.sendEmailVerificationCode(
      registerDTO.email,
      registerDTO.fullName,
      code,
    );

    return {
      message: 'A verification code has been sent to your email.',
    };
  }

  // الخطوة 2: نتحقّق من الرمز، وعندها فقط نُنشئ اليوزر ونُصدر التوكن
  async verifyEmail(dto: VerifyEmailDTO): Promise<UserResponseDTO> {
    const pending = await this.emailVerificationService.findLatestPending(
      dto.email,
    );

    if (!pending) {
      throw new NotFoundException('No pending verification for this email');
    }

    if (pending.attempts >= this.otpMaxAttempts()) {
      throw new BadRequestException(
        'Too many attempts. Please register again to get a new code.',
      );
    }

    if (pending.expiresAt < new Date()) {
      throw new BadRequestException(
        'Verification code has expired. Please register again.',
      );
    }

    const isCodeValid = await this.verifyPassword(dto.code, pending.codeHash);
    if (!isCodeValid) {
      await this.emailVerificationService.incrementAttempts(pending.id);
      throw new BadRequestException('Invalid verification code');
    }

    // احتياط ضد سباق: لو تسجّل الإيميل بين الخطوتين
    const existingUser = await this.userService.findByEmail(pending.email);
    if (existingUser) {
      await this.emailVerificationService.markConsumed(pending.id);
      throw new ConflictException('Email already in use');
    }

    const createdUser = await this.userService.create({
      fullName: pending.fullName,
      email: pending.email,
      password: pending.password, // مُجزّأة مسبقاً
      provider: AuthProvider.LOCAL,
    });

    await this.emailVerificationService.markConsumed(pending.id);

    const token = this.generateJwtToken(createdUser.id, createdUser.roles);
    return {
      userData: this.userService.mapUserWithoutPassword(createdUser),
      token,
    };
  }

  async login(loginDto: LoginDTO): Promise<UserResponseDTO> {
    const foundUser = await this.userService.findByEmail(loginDto.email);
    if (!foundUser) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!foundUser.password) {
      throw new UnauthorizedException(
        'This account uses social login. Please sign in with Google or Apple.',
      );
    }

    const isPasswordValid = await this.verifyPassword(
      loginDto.password,
      foundUser.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = this.generateJwtToken(foundUser.id, foundUser.roles);
    return {
      userData: this.userService.mapUserWithoutPassword(foundUser),
      token,
    };
  }

  async googleAuth(googleAuthDTO: GoogleAuthDTO): Promise<UserResponseDTO> {
    const clientId = this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const client = new OAuth2Client(clientId);

    let email: string;
    let name: string | undefined;
    let providerId: string;

    try {
      const ticket = await client.verifyIdToken({
        idToken: googleAuthDTO.idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email) {
        throw new BadRequestException('Google account has no email');
      }
      email = payload.email;
      name = payload.name;
      providerId = payload.sub ?? email;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new UnauthorizedException('Invalid Google token');
    }

    let user = await this.userService.findByEmail(email);

    if (!user) {
      user = await this.userService.create({
        fullName: name ?? email,
        email,
        password: null,
        provider: AuthProvider.GOOGLE,
        providerId,
      });
    }

    const token = this.generateJwtToken(user.id, user.roles);
    return {
      userData: this.userService.mapUserWithoutPassword(user),
      token,
    };
  }

  validate(userPayload: UserResponseDTO['userData']): UserResponseDTO {
    const token = this.generateJwtToken(userPayload.id, userPayload.roles);
    return {
      userData: userPayload,
      token,
    };
  }

  async forgotPassword(dto: ForgotPasswordDTO): Promise<MessageResponseDTO> {
    const user = await this.userService.findByEmail(dto.email);

    // أمنياً: نرجّع نفس الرسالة سواء وُجد الإيميل أم لا
    if (!user) {
      return { message: GENERIC_RESET_MESSAGE };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // صالح ساعة واحدة

    await this.userService.setPasswordResetToken(user.id, token, expiry);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    await this.mailService.sendPasswordResetEmail(
      user.email,
      user.fullName,
      resetLink,
    );

    return { message: GENERIC_RESET_MESSAGE };
  }

  async resetPassword(dto: ResetPasswordDTO): Promise<MessageResponseDTO> {
    const user = await this.userService.findByResetToken(dto.token);

    if (!user || !user.resetTokenExpiry) {
      throw new NotFoundException('Invalid or expired reset token');
    }

    if (user.resetTokenExpiry < new Date()) {
      throw new BadRequestException(
        'Reset token has expired. Please request a new one.',
      );
    }

    const hashedPassword = await this.hashPassword(dto.newPassword);

    await this.userService.updatePasswordAndClearReset(user.id, hashedPassword);

    return {
      message: 'Password has been reset successfully. You can now log in.',
    };
  }

  private hashPassword(password: string) {
    return argon.hash(password);
  }

  private verifyPassword(password: string, hashedPassword: string) {
    return argon.verify(hashedPassword, password);
  }

  private generateJwtToken(userId: string, roles: Role[]) {
    return this.jwtService.sign({ sub: userId, roles }, { expiresIn: '30d' });
  }

  // رمز عشوائي من 6 أرقام (آمن تشفيرياً)
  private generateOtpCode(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private otpExpiryMs(): number {
    const minutes = Number(this.configService.get<string>('OTP_EXP_MINUTES'));
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60 * 1000;
  }

  private otpMaxAttempts(): number {
    const attempts = Number(this.configService.get<string>('OTP_MAX_ATTEMPTS'));
    return Number.isFinite(attempts) && attempts > 0 ? attempts : 5;
  }
}
