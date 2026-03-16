import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, signal, WritableSignal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthTokenResponse, UserProfile } from '../models/api.models';

interface AuthState {
  isLoggedIn : boolean;
  profile ?: UserProfile;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly tokenKey : string = 'subtitle2_token';
  public readonly state : WritableSignal<AuthState> = signal<AuthState>({
    isLoggedIn: false,
  });

  public constructor(private readonly httpClient : HttpClient) {
    this.bootstrap();
  }

  /**
   * Bejelentkezés email+jelszó párossal.
   * @param email Email cím.
   * @param password Jelszó.
   * @returns Access token válasz.
   */
  public login(email : string, password : string) : Observable<AuthTokenResponse> {
    return this.httpClient
      .post<AuthTokenResponse>('/api/auth/login', { email, password })
      .pipe(tap((response : AuthTokenResponse) => this.persistToken(response.accessToken)));
  }

  /**
   * Regisztráció.
   * @param email Email cím.
   * @param password Jelszó.
   * @returns Szerver válasz.
   */
  public register(email : string, password : string) : Observable<unknown> {
    return this.httpClient.post('/api/auth/register', { email, password });
  }

  /**
   * Elfelejtett jelszó folyamat indítása.
   * @param email Email cím.
   * @returns Sikeres szerver válasz.
   */
  public forgotPassword(email : string) : Observable<unknown> {
    return this.httpClient.post('/api/auth/forgot-password', { email });
  }

  /**
   * Jelszó visszaállítása tokennel.
   * @param token Reset token.
   * @param newPassword Új jelszó.
   * @returns Sikeres szerver válasz.
   */
  public resetPassword(token : string, newPassword : string) : Observable<unknown> {
    return this.httpClient.post('/api/auth/reset-password', { token, newPassword });
  }

  /**
   * Email megerősítése tokennel.
   * @param token Megerősítő token.
   * @returns Sikeres szerver válasz.
   */
  public verifyEmail(token : string) : Observable<unknown> {
    const params : HttpParams = new HttpParams().set('token', token);
    return this.httpClient.get('/api/auth/verify-email', { params });
  }

  /**
   * Bejelentkezett felhasználó profiljának lekérése.
   * @returns Profil objektum.
   */
  public me() : Observable<UserProfile> {
    return this.httpClient.get<UserProfile>('/api/auth/me').pipe(
      tap((profile : UserProfile) => {
        this.state.set({
          isLoggedIn: true,
          profile,
        });
      }),
    );
  }

  /**
   * Kilépteti a felhasználót.
   * @returns Nem ad vissza értéket.
   */
  public logout() : void {
    localStorage.removeItem(this.tokenKey);
    this.state.set({ isLoggedIn: false });
  }

  /**
   * Token egyenleg frissítése a lokális auth profilban.
   * @param tokenBalance Friss token egyenleg.
   */
  public updateTokenBalance(tokenBalance : number) : void {
    const current : AuthState = this.state();
    if (current.isLoggedIn === false || current.profile === undefined) {
      return;
    }

    this.state.set({
      isLoggedIn: true,
      profile: {
        ...current.profile,
        tokenBalance,
      },
    });
  }

  /**
   * Ellenőrzi, hogy van-e eltárolt token.
   * @returns Igaz, ha van token.
   */
  public hasToken() : boolean {
    const token : string | null = localStorage.getItem(this.tokenKey);
    return token !== null && token.length > 0;
  }

  /**
   * Alkalmazás induláskori auth állapot visszatöltés.
   * @returns Nem ad vissza értéket.
   */
  private bootstrap() : void {
    const hasToken : boolean = this.hasToken();

    if (hasToken === false) {
      return;
    }

    this.me().subscribe({
      error: () => {
        this.logout();
      },
    });
  }

  /**
   * Token eltárolása és profil frissítés indítása.
   * @param token JWT token.
   * @returns Nem ad vissza értéket.
   */
  private persistToken(token : string) : void {
    localStorage.setItem(this.tokenKey, token);
    this.me().subscribe({
      error: () => {
        this.logout();
      },
    });
  }
}
