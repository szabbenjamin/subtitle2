import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import type { AuthUser } from '../interfaces/auth-user.interface';

interface JwtPayload {
  sub : number;
  email : string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  public constructor(private readonly jwtService : JwtService) {}

  /**
   * Ellenőrzi a Bearer tokent és beállítja a request user mezőt.
   * @param context A futó kérés kontextusa.
   * @returns Igaz, ha a token érvényes.
   */
  public async canActivate(context : ExecutionContext) : Promise<boolean> {
    const request : Request = context.switchToHttp().getRequest<Request>();
    const authHeader : string | undefined = request.headers.authorization;

    if (authHeader === undefined) {
      throw new UnauthorizedException('Hiányzó Authorization fejléc.');
    }

    const [type, token] : string[] = authHeader.split(' ');
    if (type !== 'Bearer' || token === undefined || token.length === 0) {
      throw new UnauthorizedException('Érvénytelen Authorization fejléc.');
    }

    try {
      const payload : JwtPayload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const authUser : AuthUser = {
        id: payload.sub,
        email: payload.email,
      };
      request.user = authUser;
      return true;
    } catch {
      throw new UnauthorizedException('Lejárt vagy érvénytelen token.');
    }
  }
}
