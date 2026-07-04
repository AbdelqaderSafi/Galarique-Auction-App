import { ApiProperty } from '@nestjs/swagger';
import type { SafeUser } from 'src/types/declartion-mergin';

export class VerifyPhoneDTO {
  @ApiProperty({
    description: 'Firebase ID token obtained after phone OTP on the client',
  })
  idToken!: string;
}

export type VerifyPhoneResponseDTO = {
  token: string;
  userData: SafeUser;
};
