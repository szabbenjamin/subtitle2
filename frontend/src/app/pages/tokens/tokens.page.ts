import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { finalize, timeout } from 'rxjs';
import { TokenHistoryItem } from '../../models/api.models';
import { TokenService } from '../../services/token.service';

@Component({
  selector: 'app-tokens-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tokens.page.html',
  styleUrl: './tokens.page.scss',
})
export class TokensPage implements OnInit {
  private readonly pageSize : number = 20;
  public isLoading : boolean = true;
  public rows : TokenHistoryItem[] = [];
  public visibleRowsCount : number = 20;
  public errorMessage : string = '';
  public readonly tokenCosts : Array<{ action : string; cost : string }> = [
    { action: 'Videó feltöltés', cost: '-2 token' },
    { action: 'Cím + hashtag generálás', cost: '-10 token' },
    { action: 'Videó exportálás', cost: '-1 token' },
    { action: 'Jelenetek keresése', cost: '-2 token' },
    { action: 'Aktív highlight klip export', cost: '-3 token / klip' },
    { action: 'Videó lehallgatás (Whisper)', cost: '-5 token / megkezdett perc' },
    { action: '1 hónapnál régebbi videó napi tárolási díja', cost: '-1 token / videó / nap (16:00)' },
    { action: 'Regisztrációs jóváírás', cost: '+100 token' },
    { action: 'Havi jóváírás (hó elején, ha 300 alatt van)', cost: '+100 token' },
  ];

  public constructor(private readonly tokenService : TokenService) {}

  /**
   * Oldal indulásakor history betöltése.
   */
  public ngOnInit() : void {
    this.tokenService
      .getHistory()
      .pipe(
        timeout(10000),
        finalize(() => {
          this.isLoading = false;
        }),
      )
      .subscribe({
        next: (history : TokenHistoryItem[]) => {
          this.rows = history;
          this.visibleRowsCount = this.pageSize;
          this.tokenService.refreshBalance();
        },
        error: () => {
          this.errorMessage = 'Nem sikerült betölteni a token history listát.';
        },
      });
  }

  /**
   * Előjeles token delta megjelenítés.
   */
  public formatDelta(delta : number) : string {
    return delta > 0 ? `+${delta}` : String(delta);
  }

  /**
   * A táblában megjelenítendő rows.
   */
  public visibleRows() : TokenHistoryItem[] {
    return this.rows.slice(0, this.visibleRowsCount);
  }

  /**
   * Van-e még további row, amit be lehet tölteni.
   */
  public canShowMoreRows() : boolean {
    return this.visibleRowsCount < this.rows.length;
  }

  /**
   * További 20 row megjelenítése.
   */
  public showMoreRows() : void {
    this.visibleRowsCount = Math.min(this.rows.length, this.visibleRowsCount + this.pageSize);
  }
}
