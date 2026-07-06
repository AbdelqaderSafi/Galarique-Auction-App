import { ApiProperty } from '@nestjs/swagger';

export class RequestVerificationDTO {
  @ApiProperty({
    example: '+970599123456',
    description: 'Palestinian mobile number (+970 / +972)',
  })
  phoneNumber!: string;
}

export class VerifyPhoneDTO {
  @ApiProperty({ example: '123456', description: '6-digit code sent via WhatsApp' })
  code!: string;
}

export type SellerMessageResponseDTO = { message: string };
