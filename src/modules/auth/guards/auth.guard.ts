import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { Token_Payload } from '../types/user-auth.type';
import { DatabaseService } from 'src/modules/database/database.service';
import { removeFields } from 'src/modules/utils/object.util';
import { Reflector } from '@nestjs/core';
import { IsPublic } from 'src/decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private prismaService: DatabaseService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IsPublic, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers.authorization;
    const jwt = authHeader?.split(' ')[1];
    if (!jwt) {
      throw new UnauthorizedException();
    }

    try {
      const payload = this.jwtService.verify<Token_Payload>(jwt);

      const user = await this.prismaService.user.findUniqueOrThrow({
        where: { id: payload.sub },
      });

      req.user = removeFields(user, ['password']);
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }
}
