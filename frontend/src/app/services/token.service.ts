import { HttpClient } from '@angular/common/http';
import { Injectable, WritableSignal, effect, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { AdminUserTokenItem, TokenBalanceResponse, TokenHistoryItem } from '../models/api.models';

@Injectable({ providedIn: 'root' })
export class TokenService {
  public readonly balance : WritableSignal<number | null> = signal<number | null>(null);

  public constructor(
    private readonly httpClient : HttpClient,
    private readonly authService : AuthService,
  ) {
    effect(() => {
      const authState = this.authService.state();
      if (authState.isLoggedIn === false) {
        this.balance.set(null);
        return;
      }

      const profileBalance : number | undefined = authState.profile?.tokenBalance;
      if (profileBalance !== undefined) {
        this.balance.set(profileBalance);
      }
    });
  }

  /**
   * Token egyenleg lekérése backendről.
   */
  public getBalance() : Observable<TokenBalanceResponse> {
    return this.httpClient.get<TokenBalanceResponse>('/api/tokens/balance');
  }

  /**
   * Token history lekérése backendről.
   */
  public getHistory() : Observable<TokenHistoryItem[]> {
    return this.httpClient.get<TokenHistoryItem[]>('/api/tokens/history');
  }

  /**
   * Admin: minden user token adat lekérése.
   */
  public adminListUsers() : Observable<AdminUserTokenItem[]> {
    return this.httpClient.get<AdminUserTokenItem[]>('/api/tokens/admin/users');
  }

  /**
   * Admin: user token egyenleg fix értékre állítása.
   */
  public adminSetUserBalance(userId : number, tokenBalance : number) : Observable<AdminUserTokenItem> {
    return this.httpClient.patch<AdminUserTokenItem>(`/api/tokens/admin/users/${userId}/balance`, { tokenBalance });
  }

  /**
   * Egyenleg frissítése és auth profil szinkronizálása.
   */
  public refreshBalance() : void {
    this.getBalance().subscribe({
      next: (response : TokenBalanceResponse) => {
        this.balance.set(response.tokenBalance);
        this.authService.updateTokenBalance(response.tokenBalance);
      },
    });
  }
}
