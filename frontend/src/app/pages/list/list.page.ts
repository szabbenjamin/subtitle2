import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { VideoDetails, VideoListItem } from '../../models/api.models';
import { AlertModalService } from '../../services/alert-modal.service';
import { TokenService } from '../../services/token.service';
import { ChunkUploadHandle, UploadCancelledError, VideoService } from '../../services/video.service';

@Component({
  selector: 'app-list-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './list.page.html',
  styleUrl: './list.page.scss',
})
export class ListPage implements OnInit, OnDestroy {
  @ViewChild('picker')
  public picker ?: ElementRef<HTMLInputElement>;

  public visibleVideos : VideoListItem[] = [];
  public hiddenVideos : VideoListItem[] = [];
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
    this.tokenService.refreshBalance();
    this.reloadLists();
  }

  /**
   * Oldal elhagyásakor megszakítja a még futó feltöltést.
   * @returns Nem ad vissza értéket.
   */
  public ngOnDestroy() : void {
    if (this.uploadHandle !== undefined) {
      this.uploadHandle.cancel();
      this.uploadHandle = undefined;
    }
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
    if (this.selectedFile === undefined) {
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
      this.uploadProgress = percent;
      this.uploadStatusText = status;
      this.changeDetectorRef.detectChanges();
    });
    void this.uploadHandle.promise
      .then((video : VideoDetails) => {
        this.finishUpload('Kész');
        this.tokenService.refreshBalance();
        void this.router.navigate(['/video', video.id]);
      })
      .catch((error : unknown) => {
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
    if (trimmedUrl.length === 0) {
      return;
    }

    this.isUploading = true;
    this.activeUploadKind = 'youtube';
    this.activeUploadDisplayTitle = this.deriveYoutubePlaceholderTitle(trimmedUrl);
    this.errorMessage = '';
    this.uploadProgress = 0;
    this.uploadStatusText = 'YouTube letöltés indítása...';

    this.uploadHandle = this.videoService.startYoutubeImport(trimmedUrl, (percent : number, status : string, displayTitle ?: string) => {
      this.uploadProgress = percent;
      this.uploadStatusText = status;
      if (typeof displayTitle === 'string' && displayTitle.trim().length > 0) {
        this.activeUploadDisplayTitle = displayTitle.trim();
      }
      this.changeDetectorRef.detectChanges();
    });

    void this.uploadHandle.promise
      .then((video : VideoDetails) => {
        this.finishUpload('YouTube import kész');
        this.youtubeUrl = '';
        this.tokenService.refreshBalance();
        void this.router.navigate(['/video', video.id]);
      })
      .catch((error : unknown) => {
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

    this.isUploading = false;
    this.uploadHandle = undefined;
    this.uploadProgress = 0;
    this.uploadStatusText = 'Feltöltés megszakítva';
    this.activeUploadDisplayTitle = '';
    this.activeUploadKind = null;
    this.changeDetectorRef.detectChanges();
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
    return this.isUploading === false && this.youtubeUrl.trim().length > 0;
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
    this.isLoadingLists = true;
    forkJoin({
      visible: this.videoService.list(false),
      hidden: this.videoService.list(true),
    }).subscribe({
      next: (result : { visible : VideoListItem[]; hidden : VideoListItem[] }) => {
        this.visibleVideos = result.visible;
        this.hiddenVideos = result.hidden;
        this.isLoadingLists = false;
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.isLoadingLists = false;
      },
    });
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
   * Backend hiba objektumból felhasználóbarát üzenet kinyerése.
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
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return 'A művelet nem hajtható végre. Kérlek, vedd fel a kapcsolatot a szoftver üzemeltetőjével.';
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
