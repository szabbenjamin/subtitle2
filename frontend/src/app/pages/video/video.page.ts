import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject, Subscription, debounceTime, distinctUntilChanged, map } from 'rxjs';
import { VideoDetails } from '../../models/api.models';
import { VideoService } from '../../services/video.service';

@Component({
  selector: 'app-video-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video.page.html',
  styleUrl: './video.page.scss',
})
export class VideoPage implements OnInit, OnDestroy {
  public video ?: VideoDetails;
  public subtitleText : string = '';
  public saveState : string = 'Nincs változás';
  public isLoading : boolean = true;
  public errorMessage : string = '';

  private readonly autosaveSubject : Subject<string> = new Subject<string>();
  private autosaveSubscription ?: Subscription;
  private routeSubscription ?: Subscription;

  public constructor(
    private readonly activatedRoute : ActivatedRoute,
    private readonly videoService : VideoService,
    private readonly changeDetectorRef : ChangeDetectorRef,
  ) {}

  /**
   * Oldal nyitáskor betöltés és autosave inicializálása.
   * @returns Nem ad vissza értéket.
   */
  public ngOnInit() : void {
    this.setupAutosave();
    this.routeSubscription = this.activatedRoute.paramMap
      .pipe(map((params) => Number(params.get('id') ?? '0')))
      .subscribe((videoId : number) => {
        this.loadVideo(videoId);
      });
  }

  /**
   * Erőforrások felszabadítása.
   * @returns Nem ad vissza értéket.
   */
  public ngOnDestroy() : void {
    if (this.autosaveSubscription !== undefined) {
      this.autosaveSubscription.unsubscribe();
    }
    if (this.routeSubscription !== undefined) {
      this.routeSubscription.unsubscribe();
    }
  }

  /**
   * Felirat szöveg változás eseménykezelő.
   * @returns Nem ad vissza értéket.
   */
  public onSubtitleChange() : void {
    this.saveState = 'Mentés folyamatban...';
    this.autosaveSubject.next(this.subtitleText);
  }

  /**
   * Lehallgatás kérés beküldése.
   * @returns Nem ad vissza értéket.
   */
  public requestListen() : void {
    if (this.video === undefined) {
      return;
    }

    this.videoService.requestListen(this.video.id).subscribe({
      next: (video : VideoDetails) => {
        this.video = video;
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.errorMessage = 'A lehallgatás jelölése sikertelen.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Autosave stream konfigurálása debounccal.
   * @returns Nem ad vissza értéket.
   */
  private setupAutosave() : void {
    this.autosaveSubscription = this.autosaveSubject
      .pipe(debounceTime(900), distinctUntilChanged())
      .subscribe((text : string) => {
        if (this.video === undefined) {
          return;
        }

        this.videoService.saveSubtitle(this.video.id, text).subscribe({
          next: () => {
            this.saveState = 'Mentve';
            this.changeDetectorRef.detectChanges();
          },
          error: () => {
            this.saveState = 'Mentési hiba';
            this.errorMessage = 'Nem sikerült menteni a feliratot.';
            this.changeDetectorRef.detectChanges();
          },
        });
      });
  }

  /**
   * Videó adatainak betöltése route param alapján.
   * @param videoId Videó azonosító.
   * @returns Nem ad vissza értéket.
   */
  private loadVideo(videoId : number) : void {
    this.isLoading = true;
    this.errorMessage = '';
    this.video = undefined;

    if (videoId <= 0 || Number.isNaN(videoId)) {
      this.isLoading = false;
      this.errorMessage = 'Érvénytelen videó azonosító.';
      return;
    }

    this.videoService.getById(videoId).subscribe({
      next: (video : VideoDetails) => {
        this.video = video;
        this.subtitleText = video.subtitleText;
        this.isLoading = false;
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        this.isLoading = false;
        this.errorMessage = this.extractErrorMessage(error);
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Felhasználóbarát hibaüzenet kinyerése HTTP hibából.
   * @param error Hiba objektum.
   * @returns Megjeleníthető hibaüzenet.
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
      if (error.status === 401) {
        return 'Lejárt bejelentkezés. Jelentkezz be újra.';
      }
      if (error.status === 404) {
        return 'A videó nem található vagy nincs hozzáférésed.';
      }
    }
    return 'Nem sikerült betölteni a videó oldalát.';
  }
}
