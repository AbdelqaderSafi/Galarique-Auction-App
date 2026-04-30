import type { User } from 'generated/prisma/client';

export interface EnvVariables {
  JWT_SECRET: string;
  DATABASE_URL: string;
  GOOGLE_CLIENT_ID: string;
}

declare module 'express' {
  interface Request {
    user?: Omit<User, 'password'>;
  }
}
