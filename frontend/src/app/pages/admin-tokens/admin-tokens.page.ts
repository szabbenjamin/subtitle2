import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, timeout } from 'rxjs';
import { AdminUserTokenItem } from '../../models/api.models';
import { AlertModalService } from '../../services/alert-modal.service';
import { TokenService } from '../../services/token.service';

@Component({
  selector: 'app-admin-tokens-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-tokens.page.html',
  styleUrl: './admin-tokens.page.scss',
})
export class AdminTokensPage implements OnInit {
  public rows : AdminUserTokenItem[] = [];
  public draftBalances : Record<number, number> = {};
  public isLoading : boolean = true;
  public stateText : string = '';

  public constructor(
    private readonly tokenService : TokenService,
    private readonly alertModalService : AlertModalService,
    private readonly changeDetectorRef : ChangeDetectorRef,
  ) {}

  /**
   * Oldal induláskor user lista betöltése.
   */
  public ngOnInit() : void {
    this.reload();
  }

  /**
   * User token érték mentése.
   */
  public save(row : AdminUserTokenItem) : void {
    const nextValue : number = Math.floor(Number(this.draftBalances[row.id]));
    if (Number.isFinite(nextValue) === false || nextValue < 0) {
      this.alertModalService.open('A token egyenleg csak 0 vagy annál nagyobb egész szám lehet.', 'Hiba');
      return;
    }

    this.stateText = `Mentés folyamatban: ${row.email}`;
    this.tokenService.adminSetUserBalance(row.id, nextValue).subscribe({
      next: (saved : AdminUserTokenItem) => {
        this.rows = this.rows.map((item : AdminUserTokenItem) => (item.id === saved.id ? saved : item));
        this.draftBalances[saved.id] = saved.tokenBalance;
        this.stateText = `Mentve: ${saved.email}`;
      },
      error: () => {
        this.stateText = '';
        this.alertModalService.open('A token mentés sikertelen. Kérlek próbáld újra.', 'Hiba');
      },
    });
  }

  /**
   * Újratölti az admin listát.
   */
  public reload() : void {
    this.isLoading = true;
    this.stateText = '';
    this.tokenService
      .adminListUsers()
      .pipe(
        timeout(10000),
        finalize(() => {
          this.isLoading = false;
        }),
      )
      .subscribe({
        next: (rows : AdminUserTokenItem[]) => {
          this.isLoading = false;

          try {
            if (Array.isArray(rows) === false) {
              throw new Error('Érvénytelen admin lista formátum.');
            }

            this.rows = rows;
            this.draftBalances = {};
            for (const row of rows) {
              this.draftBalances[row.id] = row.tokenBalance;
            }
          } catch (error : unknown) {
            this.rows = [];
            this.draftBalances = {};
            this.alertModalService.open(
              `Az admin lista feldolgozása sikertelen: ${String(error)}`,
              'Hiba',
            );
          }
          this.changeDetectorRef.detectChanges();
        },
        error: (error : unknown) => {
          this.isLoading = false;
          this.alertModalService.open(this.extractErrorMessage(error), 'Hiba');
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /**
   * Backend hibaüzenet kinyerése admin API hibából.
   */
  private extractErrorMessage(error : unknown) : string {
    if (error instanceof HttpErrorResponse) {
      const payload : unknown = error.error;
      if (typeof payload === 'object' && payload !== null) {
        const message : unknown = (payload as { message ?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          return message;
        }
      }
      if (typeof payload === 'string' && payload.length > 0) {
        return payload;
      }
      if (Number.isFinite(error.status) && error.status > 0) {
        return `Nem sikerült betölteni az admin user listát. (HTTP ${error.status})`;
      }
    }

    return 'Nem sikerült betölteni az admin user listát.';
  }
}
