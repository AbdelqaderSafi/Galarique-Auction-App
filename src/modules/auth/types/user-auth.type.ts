import { Role } from 'generated/prisma/client';

export type Token_Payload = {
  sub: string;
  roles: Role[];
};
