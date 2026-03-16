import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

const ADMIN_EMAIL : string = 'szabbenjamin@gmail.com';

/**
 * Csak a dedikált admin email címet engedi az útvonalra.
 */
export const adminEmailGuard : CanActivateFn = () => {
  const authService : AuthService = inject(AuthService);
  const router : Router = inject(Router);

  if (authService.hasToken() === false) {
    void router.navigate(['/login']);
    return false;
  }

  const token : string | null = localStorage.getItem('subtitle2_token');
  if (token === null || token.length === 0) {
    void router.navigate(['/login']);
    return false;
  }

  const emailFromToken : string | null = extractEmailFromJwt(token);
  if (emailFromToken === ADMIN_EMAIL) {
    return true;
  }

  void router.navigate(['/lista']);
  return false;
};

function extractEmailFromJwt(token : string) : string | null {
  try {
    const parts : string[] = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    const payloadBase64 : string = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decodedPayload : string = atob(payloadBase64);
    const payload : unknown = JSON.parse(decodedPayload);
    if (typeof payload === 'object' && payload !== null) {
      const email : unknown = (payload as { email ?: unknown }).email;
      if (typeof email === 'string' && email.length > 0) {
        return email.toLowerCase().trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}
