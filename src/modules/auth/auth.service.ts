import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import {
  GoogleAuthDTO,
  LoginDTO,
  RegisterDTO,
  UserResponseDTO,
} from './dto/auth.dto';
import * as argon from 'argon2';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Role } from 'generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { EnvVariables } from 'src/types/declartion-mergin';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private configService: ConfigService<EnvVariables>,
  ) {}

  async register(registerDTO: RegisterDTO): Promise<UserResponseDTO> {
    const hashedPassword = await this.hashPassword(registerDTO.password);

    const createdUser = await this.userService.create({
      fullName: registerDTO.fullName,
      email: registerDTO.email,
      password: hashedPassword,
      provider: AuthProvider.LOCAL,
    });

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
    const clientId = this.configService.getOrThrow('GOOGLE_CLIENT_ID');
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

  private hashPassword(password: string) {
    return argon.hash(password);
  }

  private verifyPassword(password: string, hashedPassword: string) {
    return argon.verify(hashedPassword, password);
  }

  private generateJwtToken(userId: string, roles: Role[]) {
    return this.jwtService.sign(
      { sub: userId, roles },
      { expiresIn: '30d' },
    );
  }
}
