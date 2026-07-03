import { ApiProperty } from '@nestjs/swagger';
import type { SafeUser } from 'src/types/declartion-mergin';

export class RegisterDTO {
  @ApiProperty({ example: 'Ahmed Ali' })
  fullName!: string;

  @ApiProperty({ example: 'ahmed@example.com' })
  email!: string;

  @ApiProperty({ example: 'StrongPass@123', minLength: 8 })
  password!: string;
}

export class LoginDTO {
  @ApiProperty({ example: 'ahmed@example.com' })
  email!: string;

  @ApiProperty({ example: 'StrongPass@123' })
  password!: string;
}

export class GoogleAuthDTO {
  @ApiProperty({ description: 'Google ID token received from the client SDK' })
  idToken!: string;
}

export class VerifyEmailDTO {
  @ApiProperty({ example: 'ahmed@example.com' })
  email!: string;

  @ApiProperty({ example: '123456', description: '6-digit verification code' })
  code!: string;
}

export class ForgotPasswordDTO {
  @ApiProperty({ example: 'ahmed@example.com' })
  email!: string;
}

export class ResetPasswordDTO {
  @ApiProperty({ description: 'Reset token received via email link' })
  token!: string;

  @ApiProperty({ example: 'NewStrongPass@123', minLength: 8 })
  newPassword!: string;
}

export type MessageResponseDTO = {
  message: string;
};

export type UserResponseDTO = {
  token: string;
  userData: SafeUser;
};
