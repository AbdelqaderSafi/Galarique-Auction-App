import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDTO {
  @ApiPropertyOptional({ example: 'ahmed_ali' })
  username?: string;

  @ApiPropertyOptional({ example: '2003-11-04', description: 'ISO date (YYYY-MM-DD)' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: '+970591234567' })
  phoneNumber?: string;
}
