import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AlertModalService } from './services/alert-modal.service';
import { AuthService } from './services/auth.service';
import { TokenService } from './services/token.service';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  public installPromptEvent ?: Event;
  public showInstallBar : boolean = false;
  private readonly installDismissKey : string = 'subtitle2_install_dismissed_at';
  private readonly adminEmail : string = 'szabbenjamin@gmail.com';

  public constructor(
    public readonly authService : AuthService,
    public readonly alertModalService : AlertModalService,
    public readonly tokenService : TokenService,
    public readonly themeService : ThemeService,
    private readonly router : Router,
  ) {
    this.initInstallPromptListener();
  }

  /**
   * Visszaadja, hogy a felhasználó be van-e jelentkezve.
   * @returns Igaz, ha bejelentkezett.
   */
  public isLoggedIn() : boolean {
    return this.authService.state().isLoggedIn === true || this.authService.hasToken() === true;
  }

  /**
   * Visszaadja az aktuális token egyenleget a fejléc számára.
   */
  public currentTokenBalance() : number {
    const signalBalance : number | null = this.tokenService.balance();
    if (signalBalance !== null) {
      return signalBalance;
    }
    return this.authService.state().profile?.tokenBalance ?? 0;
  }

  /**
   * Eldönti, hogy az aktuális felhasználó admin email-e.
   */
  public isAdminUser() : boolean {
    const profileEmail : string | undefined = this.authService.state().profile?.email;
    if ((profileEmail ?? '').trim().toLowerCase() === this.adminEmail) {
      return true;
    }

    const token : string | null = localStorage.getItem('subtitle2_token');
    if (token === null || token.length === 0) {
      return false;
    }

    return this.extractEmailFromJwt(token) === this.adminEmail;
  }

  /**
   * JWT payloadból email mező kinyerése.
   */
  private extractEmailFromJwt(token : string) : string | null {
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
          return email.trim().toLowerCase();
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Kilépteti a felhasználót és login oldalra navigál.
   * @returns Nem ad vissza értéket.
   */
  public logout() : void {
    this.authService.logout();
    this.tokenService.balance.set(null);
    void this.router.navigate(['/login']);
  }

  /**
   * PWA install prompt megjelenítése.
   * @returns Nem ad vissza értéket.
   */
  public async triggerInstall() : Promise<void> {
    const promptCarrier = this.installPromptEvent as {
      prompt ?: () => Promise<void>;
      userChoice ?: Promise<{ outcome : string }>;
    };

    if (promptCarrier.prompt === undefined) {
      return;
    }

    await promptCarrier.prompt();
    const userChoicePromise : Promise<{ outcome : string }> | undefined = promptCarrier.userChoice;
    if (userChoicePromise !== undefined) {
      await userChoicePromise;
    }
    this.showInstallBar = false;
  }

  /**
   * Install sáv bezárása legalább 1 napra.
   * @returns Nem ad vissza értéket.
   */
  public dismissInstallBar() : void {
    localStorage.setItem(this.installDismissKey, String(Date.now()));
    this.showInstallBar = false;
  }

  /**
   * Globális alert modal bezárása.
   */
  public closeAlertModal() : void {
    this.alertModalService.close();
  }

  /**
   * Figyeli a beforeinstallprompt eseményt.
   * @returns Nem ad vissza értéket.
   */
  private initInstallPromptListener() : void {
    window.addEventListener('beforeinstallprompt', (event : Event) => {
      event.preventDefault();
      this.installPromptEvent = event;
      const canShow : boolean = this.canShowInstallBar();
      this.showInstallBar = canShow;
    });
  }

  /**
   * Eldönti, hogy megjelenhet-e az install sáv.
   * @returns Igaz, ha megjelenhet.
   */
  private canShowInstallBar() : boolean {
    const raw : string | null = localStorage.getItem(this.installDismissKey);
    if (raw === null || raw.length === 0) {
      return true;
    }

    const dismissedAt : number = Number(raw);
    const oneDayMs : number = 24 * 60 * 60 * 1000;
    return Number.isNaN(dismissedAt) || Date.now() - dismissedAt > oneDayMs;
  }
}
