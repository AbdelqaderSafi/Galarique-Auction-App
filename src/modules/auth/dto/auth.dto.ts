import type { User } from 'generated/prisma/client';
import { ApiProperty } from '@nestjs/swagger';

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

export type UserResponseDTO = {
  token: string;
  userData: Omit<User, 'password'>;
};
