import { Reflector } from '@nestjs/core';
import { Role } from 'generated/prisma/client';

export const Roles = Reflector.createDecorator<Role[]>();
