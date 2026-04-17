import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { VideoDetails, VideoIngestTask, VideoListItem } from '../../models/api.models';
import { AlertModalService } from '../../services/alert-modal.service';
import { TokenService } from '../../services/token.service';
import { ChunkUploadHandle, UploadCancelledError, UploadDetachedError, VideoService } from '../../services/video.service';

@Component({
  selector: 'app-list-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './list.page.html',
  styleUrl: './list.page.scss',
})
export class ListPage implements OnInit, OnDestroy {
  private readonly youtubeImportStorageKey : string = 'subtitle2.activeYoutubeImport';
  private readonly listRefreshIntervalMs : number = 2000;
  @ViewChild('picker')
  public picker ?: ElementRef<HTMLInputElement>;

  public visibleVideos : VideoListItem[] = [];
  public hiddenVideos : VideoListItem[] = [];
  public activeIngestTasks : VideoIngestTask[] = [];
  public selectedFile ?: File;
  public youtubeUrl : string = '';
  public uploadProgress : number = 0;
  public uploadStatusText : string = '';
  public activeUploadDisplayTitle : string = '';
  public activeUploadKind : 'file' | 'youtube' | null = null;
  public isUploading : boolean = false;
  public hiddenOpen : boolean = false;
  public isLoadingLists : boolean = false;
  public errorMessage : string = '';
  public confirmDeleteVideo ?: VideoListItem;
  private readonly allowedMediaExtensions : ReadonlySet<string> = new Set<string>([
    '.mp4',
    '.mov',
    '.mkv',
    '.webm',
    '.avi',
    '.m4v',
    '.mp3',
    '.wav',
    '.m4a',
    '.aac',
    '.flac',
    '.ogg',
    '.oga',
    '.opus',
  ]);
  private uploadHandle ?: ChunkUploadHandle;
  private isDestroyed : boolean = false;
  private listRefreshTimer ?: ReturnType<typeof setInterval>;
  private isReloadingLists : boolean = false;

  public constructor(
    private readonly videoService : VideoService,
    private readonly alertModalService : AlertModalService,
    private readonly tokenService : TokenService,
    private readonly router : Router,
    private readonly changeDetectorRef : ChangeDetectorRef,
  ) {}

  /**
   * Oldal nyitáskor betölti a videólistákat.
   * @returns Nem ad vissza értéket.
   */
  public ngOnInit() : void {
    this.isDestroyed = false;
    this.tokenService.refreshBalance();
    this.reloadLists();
    this.startListRefreshTimer();
    this.resumeYoutubeImportFromStorage();
  }

  /**
   * Oldal elhagyásakor megszakítja a még futó feltöltést.
   * @returns Nem ad vissza értéket.
   */
  public ngOnDestroy() : void {
    this.isDestroyed = true;
    if (this.listRefreshTimer !== undefined) {
      clearInterval(this.listRefreshTimer);
      this.listRefreshTimer = undefined;
    }
    if (this.uploadHandle !== undefined) {
      if (this.activeUploadKind === 'youtube' && typeof this.uploadHandle.detach === 'function') {
        this.uploadHandle.detach();
      } else {
        this.uploadHandle.cancel();
      }
      this.uploadHandle = undefined;
    }
  }

  /**
   * Böngésző szintű figyelmeztetés tab bezárás/refresh/külső navigáció esetén.
   */
  @HostListener('window:beforeunload', ['$event'])
  public handleBeforeUnload(event : BeforeUnloadEvent) : void {
    if (this.hasBlockingFileUpload() === false) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  }

  /**
   * Fájlválasztó megnyitása.
   * @returns Nem ad vissza értéket.
   */
  public openPicker() : void {
    if (this.picker === undefined) {
      return;
    }

    this.picker.nativeElement.click();
  }

  /**
   * Fájlválasztás esemény kezelése.
   * @param event Input change esemény.
   * @returns Nem ad vissza értéket.
   */
  public onFileSelected(event : Event) : void {
    const input : HTMLInputElement = event.target as HTMLInputElement;
    const files : FileList | null = input.files;

    if (files === null || files.length === 0) {
      return;
    }

    const selected : File = files[0];
    if (this.isSupportedMediaFile(selected) === false) {
      this.selectedFile = undefined;
      this.errorMessage = 'Csak videó és hangfájl tölthető fel.';
      this.alertModalService.open(this.errorMessage, 'Hiba');
      this.uploadProgress = 0;
      return;
    }

    this.errorMessage = '';
    this.selectedFile = selected;
    this.uploadProgress = 0;
  }

  /**
   * Feltöltés indítása és progress követés.
   * @returns Nem ad vissza értéket.
   */
  public startUpload() : void {
    if (this.selectedFile === undefined || this.canShowIngestControls() === false) {
      return;
    }

    const selectedFile : File = this.selectedFile;
    this.isUploading = true;
    this.activeUploadKind = 'file';
    this.activeUploadDisplayTitle = selectedFile.name;
    this.errorMessage = '';
    this.uploadProgress = 0;
    this.uploadStatusText = 'Feltöltés indítása...';

    this.uploadHandle = this.videoService.startChunkedUpload(selectedFile, (percent : number, status : string) => {
      if (this.isDestroyed === true) {
        return;
      }
      this.uploadProgress = percent;
      this.uploadStatusText = status;
      this.changeDetectorRef.detectChanges();
    });
    void this.uploadHandle.promise
      .then((video : VideoDetails) => {
        if (this.isDestroyed === true) {
          return;
        }
        this.finishUpload('Kész');
        this.tokenService.refreshBalance();
        void this.router.navigate(['/video', video.id]);
      })
      .catch((error : unknown) => {
        if (this.isDestroyed === true) {
          return;
        }
        if (error instanceof UploadCancelledError) {
          this.finishUpload('Feltöltés megszakítva');
        } else {
          this.finishUpload('Feltöltési hiba');
          this.errorMessage = this.extractErrorMessage(error);
          this.alertModalService.open(this.errorMessage, 'Hiba');
          this.changeDetectorRef.detectChanges();
        }
      });
  }

  /**
   * YouTube URL alapú letöltés és import indítása.
   */
  public startYoutubeImport() : void {
    const trimmedUrl : string = this.youtubeUrl.trim();
    if (trimmedUrl.length === 0 || this.canShowIngestControls() === false) {
      return;
    }

    this.isUploading = true;
    this.activeUploadKind = 'youtube';
    this.activeUploadDisplayTitle = this.deriveYoutubePlaceholderTitle(trimmedUrl);
    this.errorMessage = '';
    this.uploadProgress = 0;
    this.uploadStatusText = 'YouTube letöltés indítása...';

    this.uploadHandle = this.videoService.startYoutubeImport(trimmedUrl, (percent : number, status : string, displayTitle ?: string) => {
      if (this.isDestroyed === true) {
        return;
      }
      this.uploadProgress = percent;
      this.uploadStatusText = status;
      if (typeof displayTitle === 'string' && displayTitle.trim().length > 0) {
        this.activeUploadDisplayTitle = displayTitle.trim();
        this.saveActiveYoutubeImportToStorage(this.readActiveYoutubeImportIdFromStorage(), this.activeUploadDisplayTitle);
      }
      this.changeDetectorRef.detectChanges();
    }, (importId : string, displayTitle : string) => {
      this.saveActiveYoutubeImportToStorage(importId, displayTitle);
    });

    void this.uploadHandle.promise
      .then((video : VideoDetails) => {
        if (this.isDestroyed === true) {
          return;
        }
        this.clearActiveYoutubeImportStorage();
        this.finishUpload('YouTube import kész');
        this.youtubeUrl = '';
        this.tokenService.refreshBalance();
        void this.router.navigate(['/video', video.id]);
      })
      .catch((error : unknown) => {
        if (error instanceof UploadDetachedError) {
          return;
        }
        if (this.isDestroyed === true) {
          return;
        }
        this.clearActiveYoutubeImportStorage();
        if (error instanceof UploadCancelledError) {
          this.finishUpload('YouTube letöltés megszakítva');
        } else {
          this.finishUpload('YouTube letöltési hiba');
          this.errorMessage = this.extractErrorMessage(error);
          this.alertModalService.open(this.errorMessage, 'Hiba');
          this.changeDetectorRef.detectChanges();
        }
      });
  }

  /**
   * Folyamatban lévő feltöltés megszakítása.
   * @returns Nem ad vissza értéket.
   */
  public cancelUpload() : void {
    const handle : ChunkUploadHandle | undefined = this.uploadHandle;
    if (handle === undefined) {
      return;
    }
    const wasYoutubeImport : boolean = this.activeUploadKind === 'youtube';

    this.isUploading = false;
    this.uploadHandle = undefined;
    this.uploadProgress = 0;
    this.uploadStatusText = 'Feltöltés megszakítva';
    this.activeUploadDisplayTitle = '';
    this.activeUploadKind = null;
    this.changeDetectorRef.detectChanges();
    if (wasYoutubeImport === true) {
      this.clearActiveYoutubeImportStorage();
    }
    handle.cancel();
  }

  /**
   * Aktív placeholder sor címe.
   */
  public activeUploadTitle() : string {
    if (this.activeUploadDisplayTitle.trim().length > 0) {
      return this.activeUploadDisplayTitle.trim();
    }

    if (this.activeUploadKind === 'youtube') {
      return 'YouTube videó';
    }
    if (this.activeUploadKind === 'file') {
      return 'Új feltöltés';
    }
    return 'Feldolgozás';
  }

  /**
   * YouTube import indítható-e.
   */
  public canStartYoutubeImport() : boolean {
    return this.canShowIngestControls() === true && this.youtubeUrl.trim().length > 0;
  }

  /**
   * Feltöltési/letöltési vezérlők megjelenhetnek-e.
   * Lokális vagy másik eszközön futó ingest közben új folyamat nem indítható.
   */
  public canShowIngestControls() : boolean {
    return this.isUploading === false && this.activeIngestTasks.length === 0;
  }

  /**
   * Van-e olyan aktív fájlfeltöltés, aminél oldalelhagyás megszakítja a folyamatot.
   */
  public hasBlockingFileUpload() : boolean {
    return this.isUploading === true && this.activeUploadKind === 'file' && this.uploadHandle !== undefined;
  }

  /**
   * Rejtett állapot kapcsolása egy videón.
   * @param video Videó listaelem.
   * @param hidden Új rejtett érték.
   * @returns Nem ad vissza értéket.
   */
  public toggleHidden(video : VideoListItem, hidden : boolean) : void {
    this.videoService.setHidden(video.id, hidden).subscribe({
      next: () => {
        this.reloadLists();
      },
    });
  }

  /**
   * Törlési megerősítő modal megnyitása.
   */
  public openDeleteConfirm(video : VideoListItem) : void {
    this.confirmDeleteVideo = video;
  }

  /**
   * Törlési megerősítő modal bezárása.
   */
  public closeDeleteConfirm() : void {
    this.confirmDeleteVideo = undefined;
  }

  /**
   * Rejtett videó végleges törlése.
   */
  public confirmDeleteVideoNow() : void {
    const target : VideoListItem | undefined = this.confirmDeleteVideo;
    if (target === undefined) {
      return;
    }

    this.videoService.remove(target.id).subscribe({
      next: () => {
        this.closeDeleteConfirm();
        this.reloadLists();
      },
      error: (error : unknown) => {
        this.closeDeleteConfirm();
        this.errorMessage = this.extractErrorMessage(error);
        this.alertModalService.open(this.errorMessage, 'Hiba');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Másodpercből HH:MM:SS formátum.
   * @param totalSeconds Teljes idő másodpercben.
   * @returns Formázott idő.
   */
  public formatDuration(totalSeconds : number) : string {
    const hours : number = Math.floor(totalSeconds / 3600);
    const minutes : number = Math.floor((totalSeconds % 3600) / 60);
    const seconds : number = totalSeconds % 60;
    return [hours, minutes, seconds].map((value : number) => String(value).padStart(2, '0')).join(':');
  }

  /**
   * Fájlnév + méret felirat az upload gombhoz.
   * @returns Leíró szöveg.
   */
  public uploadButtonText() : string {
    if (this.selectedFile === undefined) {
      return 'Új videó feltöltése';
    }

    const megabytes : number = this.selectedFile.size / 1024 / 1024;
    return `${this.selectedFile.name} (${megabytes.toFixed(2)} MB)`;
  }

  /**
   * Látható és rejtett lista újratöltése.
   * @returns Nem ad vissza értéket.
   */
  private reloadLists() : void {
    this.reloadListsInternal(false);
  }

  /**
   * Pollolt lista + ingest állapot frissítés.
   * @param silent True esetén nem jelenít meg globális "Lista betöltése..." állapotot.
   */
  private reloadListsInternal(silent : boolean) : void {
    if (this.isReloadingLists === true) {
      return;
    }

    this.isReloadingLists = true;
    if (silent === false) {
      this.isLoadingLists = true;
    }
    forkJoin({
      visible: this.videoService.list(false),
      hidden: this.videoService.list(true),
      ingestTasks: this.videoService.listActiveIngestTasks(),
    }).subscribe({
      next: (result : { visible : VideoListItem[]; hidden : VideoListItem[]; ingestTasks : VideoIngestTask[] }) => {
        if (this.isDestroyed === true) {
          this.isReloadingLists = false;
          return;
        }
        this.visibleVideos = result.visible;
        this.hiddenVideos = result.hidden;
        this.activeIngestTasks = result.ingestTasks;
        this.isLoadingLists = false;
        this.isReloadingLists = false;
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.isReloadingLists = false;
        this.isLoadingLists = false;
      },
    });
  }

  /**
   * Háttér listafrissítés indítása, hogy több gépen is látszódjanak az aktív ingest folyamatok.
   */
  private startListRefreshTimer() : void {
    if (this.listRefreshTimer !== undefined) {
      clearInterval(this.listRefreshTimer);
    }

    this.listRefreshTimer = setInterval(() => {
      if (this.isDestroyed === true) {
        return;
      }
      this.reloadListsInternal(true);
    }, this.listRefreshIntervalMs);
  }

  /**
   * Feltöltés lezárási állapotának egységes beállítása.
   * @param statusText Lezáró státusz üzenet.
   * @returns Nem ad vissza értéket.
   */
  private finishUpload(statusText : string) : void {
    this.isUploading = false;
    this.uploadHandle = undefined;
    this.uploadStatusText = statusText;
    this.activeUploadDisplayTitle = '';
    this.activeUploadKind = null;
    this.changeDetectorRef.detectChanges();
  }

  /**
   * Ha van mentett, még futó YouTube import, visszaállítja a helyi progress követést.
   */
  private resumeYoutubeImportFromStorage() : void {
    if (this.isUploading === true) {
      return;
    }

    const storedImportId : string = this.readActiveYoutubeImportIdFromStorage();
    if (storedImportId.length === 0) {
      return;
    }

    this.isUploading = true;
    this.activeUploadKind = 'youtube';
    this.activeUploadDisplayTitle = this.readActiveYoutubeImportTitleFromStorage();
    this.uploadProgress = 0;
    this.uploadStatusText = 'YouTube letöltés folytatása...';
    this.errorMessage = '';

    this.uploadHandle = this.videoService.resumeYoutubeImport(
      storedImportId,
      (percent : number, status : string, displayTitle ?: string) => {
        if (this.isDestroyed === true) {
          return;
        }
        this.uploadProgress = percent;
        this.uploadStatusText = status;
        if (typeof displayTitle === 'string' && displayTitle.trim().length > 0) {
          this.activeUploadDisplayTitle = displayTitle.trim();
          this.saveActiveYoutubeImportToStorage(storedImportId, this.activeUploadDisplayTitle);
        }
        this.changeDetectorRef.detectChanges();
      },
    );

    void this.uploadHandle.promise
      .then((video : VideoDetails) => {
        if (this.isDestroyed === true) {
          return;
        }
        this.clearActiveYoutubeImportStorage();
        this.finishUpload('YouTube import kész');
        this.youtubeUrl = '';
        this.tokenService.refreshBalance();
        void this.router.navigate(['/video', video.id]);
      })
      .catch((error : unknown) => {
        if (error instanceof UploadDetachedError) {
          return;
        }
        if (this.isDestroyed === true) {
          return;
        }
        this.clearActiveYoutubeImportStorage();
        if (error instanceof UploadCancelledError) {
          this.finishUpload('YouTube letöltés megszakítva');
        } else {
          this.finishUpload('YouTube letöltési hiba');
          this.errorMessage = this.extractErrorMessage(error);
          this.alertModalService.open(this.errorMessage, 'Hiba');
          this.changeDetectorRef.detectChanges();
        }
      });
  }

  /**
   * Aktív YouTube import állapot mentése kliens oldalon (navigáció túléléséhez).
   */
  private saveActiveYoutubeImportToStorage(importId : string, displayTitle : string) : void {
    const trimmedImportId : string = importId.trim();
    if (trimmedImportId.length === 0) {
      return;
    }
    try {
      localStorage.setItem(
        this.youtubeImportStorageKey,
        JSON.stringify({
          importId: trimmedImportId,
          displayTitle: displayTitle.trim(),
        }),
      );
    } catch {
      // Szándékosan csendes fallback.
    }
  }

  /**
   * Aktív YouTube import tárolt azonosítójának kiolvasása.
   */
  private readActiveYoutubeImportIdFromStorage() : string {
    try {
      const raw : string | null = localStorage.getItem(this.youtubeImportStorageKey);
      if (raw === null || raw.trim().length === 0) {
        return '';
      }
      const parsed : unknown = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return '';
      }
      const importId : unknown = (parsed as { importId ?: unknown }).importId;
      return typeof importId === 'string' ? importId.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * Aktív YouTube import tárolt címének kiolvasása.
   */
  private readActiveYoutubeImportTitleFromStorage() : string {
    try {
      const raw : string | null = localStorage.getItem(this.youtubeImportStorageKey);
      if (raw === null || raw.trim().length === 0) {
        return '';
      }
      const parsed : unknown = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return '';
      }
      const title : unknown = (parsed as { displayTitle ?: unknown }).displayTitle;
      return typeof title === 'string' ? title.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * Aktív YouTube import állapot törlése kliens tárolóból.
   */
  private clearActiveYoutubeImportStorage() : void {
    try {
      localStorage.removeItem(this.youtubeImportStorageKey);
    } catch {
      // Szándékosan csendes fallback.
    }
  }

  /**
   * Backend hiba objektumból felhasználóbarát üzenet kinyerése.
   */
  private extractErrorMessage(error : unknown) : string {
    if (error instanceof HttpErrorResponse) {
      const payload : unknown = error.error;
      if (typeof payload === 'object' && payload !== null) {
        const message : unknown = (payload as { message ?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          if (this.isLikelyHtmlErrorPage(message) === true) {
            return this.toHttpErrorMessage(error.status);
          }
          return message;
        }
      }
      if (typeof payload === 'string' && payload.length > 0) {
        if (this.isLikelyHtmlErrorPage(payload) === true) {
          return this.toHttpErrorMessage(error.status);
        }
        return payload;
      }
      return this.toHttpErrorMessage(error.status);
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return 'A művelet nem hajtható végre. Kérlek, vedd fel a kapcsolatot a szoftver üzemeltetőjével.';
  }

  /**
   * Egyszerű HTML hibalap detektálás nyers payload esetén.
   */
  private isLikelyHtmlErrorPage(payload : string) : boolean {
    const normalized : string = payload.trim().toLowerCase();
    return (
      normalized.startsWith('<!doctype html') ||
      normalized.startsWith('<html') ||
      (normalized.includes('<body') && normalized.includes('</html>'))
    );
  }

  /**
   * HTTP státuszkód alapú, rövid felhasználóbarát hibaüzenet.
   */
  private toHttpErrorMessage(status : number) : string {
    if (status === 0) {
      return 'A szerver jelenleg nem érhető el. Kérlek, próbáld újra.';
    }
    if (status === 502 || status === 503 || status === 504) {
      return `Átmeneti szerverkapcsolati hiba (HTTP ${status}). A háttérfolyamat még futhat, kérlek próbáld újra pár másodperc múlva.`;
    }
    if (status >= 500) {
      return `Szerverhiba történt (HTTP ${status}). Kérlek, próbáld újra később.`;
    }
    if (status > 0) {
      return `A kérés sikertelen (HTTP ${status}).`;
    }
    return 'A művelet nem hajtható végre. Kérlek, próbáld újra később.';
  }

  /**
   * Frontend oldali médiafájl ellenőrzés (MIME + kiterjesztés).
   */
  private isSupportedMediaFile(file : File) : boolean {
    const mime : string = file.type.trim().toLowerCase();
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      return true;
    }

    const name : string = file.name.trim().toLowerCase();
    const dotIndex : number = name.lastIndexOf('.');
    if (dotIndex < 0) {
      return false;
    }

    const extension : string = name.slice(dotIndex);
    return this.allowedMediaExtensions.has(extension);
  }

  /**
   * YouTube URL-ből kezdeti, felhasználóbarát cím készítése.
   */
  private deriveYoutubePlaceholderTitle(url : string) : string {
    try {
      const parsed : URL = new URL(url);
      const videoId : string = parsed.searchParams.get('v')?.trim() ?? '';
      if (videoId.length > 0) {
        return `YouTube: ${videoId}`;
      }
      const pathname : string = parsed.pathname.trim().replace(/^\/+/, '');
      if (pathname.length > 0) {
        return `YouTube: ${pathname}`;
      }
    } catch {
      // Szándékosan csendes fallback.
    }

    return 'YouTube videó';
  }
}
