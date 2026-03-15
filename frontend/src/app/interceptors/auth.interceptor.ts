import { HttpInterceptorFn } from '@angular/common/http';

/**
 * JWT tokent illeszt a kimenő API kérésekhez, ha van bejelentkezés.
 * @param request Kimenő kérés.
 * @param next Következő interceptor vagy backend handler.
 * @returns Interceptor lánc eredménye.
 */
export const authInterceptor : HttpInterceptorFn = (request, next) => {
  const token : string | null = localStorage.getItem('subtitle2_token');

  if (token === null || token.length === 0) {
    return next(request);
  }

  const withAuth = request.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`,
    },
  });

  return next(withAuth);
};
