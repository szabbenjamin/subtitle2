import type { AuthUser } from '../common/interfaces/auth-user.interface';

declare global {
  namespace Express {
    interface Request {
      user ?: AuthUser;
    }
  }
}

export {};
