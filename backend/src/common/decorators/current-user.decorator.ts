import { UnauthorizedException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { AuthUser } from '../interfaces/auth-user.interface';

/**
 * A JWT-ből dekódolt aktuális felhasználót adja vissza.
 */
export const CurrentUser = createParamDecorator(
  (data : unknown, context : ExecutionContext) : AuthUser => {
    void data;
    const request : Request = context.switchToHttp().getRequest<Request>();
    if (request.user === undefined) {
      throw new UnauthorizedException('Hiányzó user kontextus.');
    }

    return request.user;
  },
);
