import { Injectable, signal, WritableSignal } from '@angular/core';

export type AppTheme = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly storageKey : string = 'subtitle2_theme';
  public readonly theme : WritableSignal<AppTheme> = signal<AppTheme>('light');

  public constructor() {
    this.loadTheme();
  }

  /**
   * Téma váltása és mentése localStorage-be.
   * @returns Nem ad vissza értéket.
   */
  public toggleTheme() : void {
    const currentTheme : AppTheme = this.theme();
    const nextTheme : AppTheme = currentTheme === 'light' ? 'dark' : 'light';
    this.theme.set(nextTheme);
    localStorage.setItem(this.storageKey, nextTheme);
    this.applyTheme(nextTheme);
  }

  /**
   * Betölti a mentett témát.
   * @returns Nem ad vissza értéket.
   */
  private loadTheme() : void {
    const savedTheme : string | null = localStorage.getItem(this.storageKey);
    const isDarkTheme : boolean = savedTheme === 'dark';
    const theme : AppTheme = isDarkTheme ? 'dark' : 'light';
    this.theme.set(theme);
    this.applyTheme(theme);
  }

  /**
   * A dokumentum gyökerére felteszi az aktuális témát.
   * @param theme Választott téma.
   * @returns Nem ad vissza értéket.
   */
  private applyTheme(theme : AppTheme) : void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
