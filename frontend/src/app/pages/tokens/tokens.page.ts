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
  public isLoading : boolean = true;
  public rows : TokenHistoryItem[] = [];
  public errorMessage : string = '';
  public readonly tokenCosts : Array<{ action : string; cost : string }> = [
    { action: 'Videó feltöltés', cost: '-2 token' },
    { action: 'Cím + hashtag generálás', cost: '-10 token' },
    { action: 'Videó exportálás', cost: '-1 token' },
    { action: 'Videó lehallgatás (Whisper)', cost: '-5 token / megkezdett perc' },
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
}
