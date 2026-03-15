import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Csak bejelentkezett felhasználónak engedi az útvonalat.
 * @returns Igaz, ha az útvonal engedélyezett.
 */
export const authGuard : CanActivateFn = () => {
  const authService : AuthService = inject(AuthService);
  const router : Router = inject(Router);
  const hasToken : boolean = authService.hasToken();

  if (hasToken === true) {
    return true;
  }

  void router.navigate(['/login']);
  return false;
};
