import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, forkJoin, map } from 'rxjs';
import {
  HighlightExportedVideo,
  HighlightMode,
  VideoDetails,
  VideoHighlightAnalysis,
  VideoHighlightClip,
} from '../../models/api.models';
import { AlertModalService } from '../../services/alert-modal.service';
import { TokenService } from '../../services/token.service';
import { VideoService } from '../../services/video.service';

type ClipRangeMap = Record<number, { startSeconds : number; endSeconds : number }>;

@Component({
  selector: 'app-video-highlights-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video-highlights.page.html',
  styleUrl: './video-highlights.page.scss',
})
export class VideoHighlightsPage implements OnInit, OnDestroy {
  @ViewChild('player')
  public playerRef ?: ElementRef<HTMLVideoElement>;

  public video ?: VideoDetails;
  public analysis : VideoHighlightAnalysis | null = null;
  public selectedMode : HighlightMode = 'balanced';
  public isLoading : boolean = true;
  public isStartingAnalysis : boolean = false;
  public isExporting : boolean = false;
  public processingText : string = '';
  public successMessage : string = '';
  public errorMessage : string = '';
  public exportedClipVideoId : number | null = null;
  public durationSeconds : number = 0;
  public currentTimeSeconds : number = 0;
  public isPlaying : boolean = false;
  public activeClipId : number | null = null;
  public clipRanges : ClipRangeMap = {};
  private readonly playbackBoundaryEpsilonSeconds : number = 0.05;

  public readonly modeOptions : Array<{ value : HighlightMode; label : string; helper : string }> = [
    { value: 'balanced', label: 'Kiegyensúlyozott', helper: 'Vegyesen keresi a jó pillanatokat.' },
    { value: 'funny', label: 'Vicces', helper: 'Humoros, pörgős és poénos részeket emel ki.' },
    { value: 'emotional', label: 'Érzelmes', helper: 'Erős érzelmi hangsúlyú jeleneteket keres.' },
    { value: 'informative', label: 'Informatív', helper: 'Tényeket, tippeket és lényegi részeket preferál.' },
    { value: 'dynamic', label: 'Dinamikus', helper: 'Tempós, energikus szakaszokat rangsorol előre.' },
  ];

  private routeSubscription ?: Subscription;
  private pollTimer ?: ReturnType<typeof setInterval>;
  private playbackBoundaryTimer ?: ReturnType<typeof setInterval>;

  public constructor(
    private readonly activatedRoute : ActivatedRoute,
    private readonly router : Router,
    private readonly videoService : VideoService,
    private readonly alertModalService : AlertModalService,
    private readonly tokenService : TokenService,
    private readonly changeDetectorRef : ChangeDetectorRef,
  ) {}

  /**
   * Oldal induláskor route alapján betölt.
   */
  public ngOnInit() : void {
    this.routeSubscription = this.activatedRoute.paramMap
      .pipe(map((params) => Number(params.get('id') ?? '0')))
      .subscribe((videoId : number) => {
        this.loadPage(videoId);
      });
  }

  /**
   * Erőforrás felszabadítás.
   */
  public ngOnDestroy() : void {
    if (this.routeSubscription !== undefined) {
      this.routeSubscription.unsubscribe();
    }
    this.stopPolling();
    this.stopPlaybackBoundaryWatcher();
  }

  /**
   * Keresés indítása kiválasztott móddal.
   */
  public startSceneSearch() : void {
    if (this.video === undefined) {
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';
    this.exportedClipVideoId = null;
    this.isStartingAnalysis = true;
    this.processingText = 'Elemzés indítása...';

    this.videoService.startHighlightAnalysis(this.video.id, this.selectedMode).subscribe({
      next: (analysis : VideoHighlightAnalysis) => {
        this.analysis = analysis;
        this.processingText = analysis.stageMessage;
        this.isStartingAnalysis = false;
        this.tokenService.refreshBalance();
        this.syncClipStateFromAnalysis();
        this.startPollingIfNeeded();
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        this.isStartingAnalysis = false;
        this.processingText = '';
        this.errorMessage = this.extractErrorMessage(error, 'A jelenetkeresés indítása sikertelen.');
        this.alertModalService.open(this.errorMessage, 'Hiba');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Lejátszás kapcsoló.
   */
  public togglePlayback() : void {
    const player : HTMLVideoElement | undefined = this.playerRef?.nativeElement;
    if (player === undefined) {
      return;
    }

    if (player.paused === true) {
      const activeRange : { startSeconds : number; endSeconds : number } | null = this.activeClipRange();
      if (activeRange !== null) {
        if (player.currentTime >= activeRange.endSeconds - this.playbackBoundaryEpsilonSeconds) {
          player.currentTime = activeRange.startSeconds;
          this.currentTimeSeconds = activeRange.startSeconds;
        } else if (player.currentTime < activeRange.startSeconds) {
          player.currentTime = activeRange.startSeconds;
          this.currentTimeSeconds = activeRange.startSeconds;
        }
      }
      void player.play();
      this.isPlaying = true;
      this.startPlaybackBoundaryWatcher();
      return;
    }

    player.pause();
    this.isPlaying = false;
    this.stopPlaybackBoundaryWatcher();
  }

  /**
   * Timeline seek input változása.
   */
  public onTimelineSeek(nextSeconds : number) : void {
    this.seekTo(nextSeconds);
  }

  /**
   * Video metadata betöltve esemény.
   */
  public onVideoMetadata(event : Event) : void {
    const target : EventTarget | null = event.target;
    if (target instanceof HTMLVideoElement) {
      this.durationSeconds = Number.isFinite(target.duration) ? target.duration : this.durationSeconds;
    }
  }

  /**
   * Video időfrissítés.
   */
  public onVideoTimeUpdate(event : Event) : void {
    const target : EventTarget | null = event.target;
    if (target instanceof HTMLVideoElement) {
      if (this.enforceActiveClipPlaybackBoundary(target) === true) {
        return;
      }

      this.currentTimeSeconds = target.currentTime;
      this.isPlaying = target.paused === false;
    }
  }

  /**
   * Video play esemény.
   */
  public onVideoPlay() : void {
    this.isPlaying = true;
    this.startPlaybackBoundaryWatcher();
  }

  /**
   * Video pause esemény.
   */
  public onVideoPause() : void {
    this.isPlaying = false;
    this.stopPlaybackBoundaryWatcher();
  }

  /**
   * Kijelölt klip beállítása és seek.
   */
  public activateClip(clip : VideoHighlightClip) : void {
    this.activeClipId = clip.id;
    this.ensureClipRange(clip);
    this.seekTo(this.clipRanges[clip.id].startSeconds);
  }

  /**
   * Aktív klip kezdetének beállítása a jelenlegi lejátszási pozícióhoz.
   */
  public setActiveClipStartFromCurrent() : void {
    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      return;
    }
    this.ensureClipRange(clip);
    const range = this.clipRanges[clip.id];
    const nextStart : number = this.clamp(this.currentTimeSeconds, 0, range.endSeconds - 0.1);
    this.clipRanges = {
      ...this.clipRanges,
      [clip.id]: {
        ...range,
        startSeconds: Number(nextStart.toFixed(3)),
      },
    };
  }

  /**
   * Aktív klip végének beállítása a jelenlegi lejátszási pozícióhoz.
   */
  public setActiveClipEndFromCurrent() : void {
    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      return;
    }
    this.ensureClipRange(clip);
    const range = this.clipRanges[clip.id];
    const maxDuration : number = this.durationSeconds > 0 ? this.durationSeconds : Math.max(range.endSeconds, clip.endSeconds);
    const nextEnd : number = this.clamp(this.currentTimeSeconds, range.startSeconds + 0.1, maxDuration);
    this.clipRanges = {
      ...this.clipRanges,
      [clip.id]: {
        ...range,
        endSeconds: Number(nextEnd.toFixed(3)),
      },
    };
  }

  /**
   * Aktív klip kezdőpont manuális módosítása.
   */
  public onActiveClipStartChanged(value : number) : void {
    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      return;
    }

    this.ensureClipRange(clip);
    const range = this.clipRanges[clip.id];
    const nextStart : number = this.clamp(value, 0, range.endSeconds - 0.1);
    this.clipRanges = {
      ...this.clipRanges,
      [clip.id]: {
        ...range,
        startSeconds: Number(nextStart.toFixed(3)),
      },
    };
  }

  /**
   * Aktív klip végpont manuális módosítása.
   */
  public onActiveClipEndChanged(value : number) : void {
    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      return;
    }

    this.ensureClipRange(clip);
    const range = this.clipRanges[clip.id];
    const maxDuration : number = this.durationSeconds > 0 ? this.durationSeconds : Math.max(range.endSeconds, clip.endSeconds);
    const nextEnd : number = this.clamp(value, range.startSeconds + 0.1, maxDuration);
    this.clipRanges = {
      ...this.clipRanges,
      [clip.id]: {
        ...range,
        endSeconds: Number(nextEnd.toFixed(3)),
      },
    };
  }

  /**
   * Aktív klip kezdőpont százalékos pozíciója a timeline-on.
   */
  public activeClipStartPercent() : number {
    const range = this.activeClipRange();
    const maxDuration : number = this.durationSeconds;
    if (range === null || maxDuration <= 0) {
      return 0;
    }
    return this.clamp((range.startSeconds / maxDuration) * 100, 0, 100);
  }

  /**
   * Aktív klip végpont százalékos pozíciója a timeline-on.
   */
  public activeClipEndPercent() : number {
    const range = this.activeClipRange();
    const maxDuration : number = this.durationSeconds;
    if (range === null || maxDuration <= 0) {
      return 0;
    }
    return this.clamp((range.endSeconds / maxDuration) * 100, 0, 100);
  }

  /**
   * Aktív klip szélessége százalékban.
   */
  public activeClipWidthPercent() : number {
    const startPercent : number = this.activeClipStartPercent();
    const endPercent : number = this.activeClipEndPercent();
    return this.clamp(endPercent - startPercent, 0, 100);
  }

  /**
   * Rendszerindoklás visszajelzése.
   */
  public submitReasonFeedback(clip : VideoHighlightClip, isAccurate : boolean) : void {
    if (this.video === undefined) {
      return;
    }

    this.videoService
      .updateHighlightClipFeedback(this.video.id, clip.id, {
        isAccurate,
      })
      .subscribe({
        next: (updatedClip : VideoHighlightClip) => {
          if (this.analysis === null) {
            return;
          }
          this.analysis = {
            ...this.analysis,
            clips: this.analysis.clips.map((item : VideoHighlightClip) => (item.id === updatedClip.id ? updatedClip : item)),
          };
          this.changeDetectorRef.detectChanges();
        },
        error: (error : unknown) => {
          this.errorMessage = this.extractErrorMessage(error, 'A visszajelzés mentése sikertelen.');
          this.alertModalService.open(this.errorMessage, 'Hiba');
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /**
   * Aktív klip exportálása külön videóként.
   */
  public exportActiveClip() : void {
    if (this.video === undefined || this.analysis === null) {
      return;
    }

    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      this.errorMessage = 'Valassz ki egy klipet exportalasra.';
      this.alertModalService.open(this.errorMessage, 'Hiányzó klip');
      return;
    }
    this.ensureClipRange(clip);
    const range = this.clipRanges[clip.id];

    this.isExporting = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.exportedClipVideoId = null;
    this.processingText = 'Klip exportálása folyamatban...';

    const payload : { clips : Array<{ clipId : number; startSeconds : number; endSeconds : number }> } = {
      clips: [
        {
          clipId: clip.id,
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
        },
      ],
    };

    this.videoService.exportHighlightClips(this.video.id, payload).subscribe({
      next: (createdVideos : HighlightExportedVideo[]) => {
        this.isExporting = false;
        this.processingText = '';
        if (createdVideos.length === 0) {
          this.successMessage = 'Nem jött létre új klipfájl.';
          this.changeDetectorRef.detectChanges();
          return;
        }
        this.exportedClipVideoId = createdVideos[0].id;
        this.successMessage = 'A kijelölt klip exportja kész, az új videó bekerült a listába.';
        this.tokenService.refreshBalance();
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        this.isExporting = false;
        this.processingText = '';
        this.errorMessage = this.extractErrorMessage(error, 'A klip export sikertelen.');
        this.alertModalService.open(this.errorMessage, 'Hiba');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Visszanavigál az eredeti videó oldalra.
   */
  public backToVideo() : void {
    if (this.video === undefined) {
      void this.router.navigate(['/lista']);
      return;
    }
    void this.router.navigate(['/video', this.video.id]);
  }

  /**
   * Exportált klip megnyitása a videó aloldalon.
   */
  public openExportedClip() : void {
    if (this.exportedClipVideoId === null) {
      return;
    }
    void this.router.navigate(['/video', this.exportedClipVideoId]);
  }

  /**
   * Idő formázása MM:SS vagy HH:MM:SS formára.
   */
  public formatTime(totalSeconds : number) : string {
    const safeTotal : number = Math.max(0, Math.floor(totalSeconds));
    const hours : number = Math.floor(safeTotal / 3600);
    const minutes : number = Math.floor((safeTotal % 3600) / 60);
    const seconds : number = safeTotal % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * Aktív klip range adata.
   */
  public activeClipRange() : { startSeconds : number; endSeconds : number } | null {
    const clip : VideoHighlightClip | undefined = this.activeClip();
    if (clip === undefined) {
      return null;
    }
    this.ensureClipRange(clip);
    return this.clipRanges[clip.id] ?? null;
  }

  /**
   * Jelenleg fut-e elemzés.
   */
  public isAnalysisRunning() : boolean {
    if (this.analysis === null) {
      return false;
    }
    return this.analysis.status === 'queued' || this.analysis.status === 'processing';
  }

  /**
   * Kereső gomb elérhetősége.
   */
  public canSearchScenes() : boolean {
    return this.video !== undefined && this.video.durationSeconds >= 240 && this.isStartingAnalysis === false;
  }

  /**
   * Aktív klip export engedélyezett-e.
   */
  public canExportActiveClip() : boolean {
    return this.activeClip() !== undefined && this.isExporting === false;
  }

  private loadPage(videoId : number) : void {
    this.isLoading = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.processingText = '';
    this.exportedClipVideoId = null;
    this.analysis = null;
    this.video = undefined;
    this.clipRanges = {};
    this.activeClipId = null;
    this.stopPolling();
    this.stopPlaybackBoundaryWatcher();

    if (videoId <= 0 || Number.isNaN(videoId)) {
      this.isLoading = false;
      this.errorMessage = 'Érvénytelen videó azonosító.';
      return;
    }

    forkJoin({
      video: this.videoService.getById(videoId),
      analysis: this.videoService.getLatestHighlightAnalysis(videoId),
    }).subscribe({
      next: (result : { video : VideoDetails; analysis : VideoHighlightAnalysis | null }) => {
        this.video = result.video;
        this.durationSeconds = Number.isFinite(result.video.durationSeconds) ? result.video.durationSeconds : 0;
        this.analysis = result.analysis;
        this.selectedMode = result.analysis?.mode ?? 'balanced';
        this.processingText = result.analysis !== null ? result.analysis.stageMessage : '';
        this.isLoading = false;
        this.syncClipStateFromAnalysis();
        this.startPollingIfNeeded();
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        this.isLoading = false;
        this.errorMessage = this.extractErrorMessage(error, 'A highlights oldal betöltése sikertelen.');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  private startPollingIfNeeded() : void {
    if (this.video === undefined || this.analysis === null) {
      this.stopPolling();
      return;
    }

    if (this.isAnalysisRunning() === false) {
      this.stopPolling();
      return;
    }

    if (this.pollTimer !== undefined) {
      return;
    }

    this.pollTimer = setInterval(() => {
      if (this.video === undefined) {
        return;
      }
      this.videoService.getLatestHighlightAnalysis(this.video.id).subscribe({
        next: (analysis : VideoHighlightAnalysis | null) => {
          this.analysis = analysis;
          this.processingText = analysis?.stageMessage ?? '';
          this.syncClipStateFromAnalysis();
          if (analysis === null || (analysis.status !== 'queued' && analysis.status !== 'processing')) {
            this.stopPolling();
          }
          this.changeDetectorRef.detectChanges();
        },
      });
    }, 2500);
  }

  private stopPolling() : void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Lejátszás közben külön őr figyeli, hogy az aktív klip vége után azonnal álljon meg.
   */
  private startPlaybackBoundaryWatcher() : void {
    if (this.playbackBoundaryTimer !== undefined) {
      return;
    }

    this.playbackBoundaryTimer = setInterval(() => {
      const player : HTMLVideoElement | undefined = this.playerRef?.nativeElement;
      if (player === undefined) {
        return;
      }
      if (player.paused === true) {
        this.stopPlaybackBoundaryWatcher();
        return;
      }
      this.enforceActiveClipPlaybackBoundary(player);
    }, 100);
  }

  private stopPlaybackBoundaryWatcher() : void {
    if (this.playbackBoundaryTimer !== undefined) {
      clearInterval(this.playbackBoundaryTimer);
      this.playbackBoundaryTimer = undefined;
    }
  }

  private enforceActiveClipPlaybackBoundary(player : HTMLVideoElement) : boolean {
    const activeRange : { startSeconds : number; endSeconds : number } | null = this.activeClipRange();
    if (activeRange === null) {
      return false;
    }

    const normalizedEnd : number = Math.max(activeRange.startSeconds + 0.1, activeRange.endSeconds);
    if (player.paused === false && player.currentTime >= normalizedEnd - this.playbackBoundaryEpsilonSeconds) {
      const safeEndSeconds : number = this.clamp(normalizedEnd, 0, this.durationSeconds > 0 ? this.durationSeconds : normalizedEnd);
      player.currentTime = safeEndSeconds;
      player.pause();
      this.currentTimeSeconds = safeEndSeconds;
      this.isPlaying = false;
      this.stopPlaybackBoundaryWatcher();
      return true;
    }

    return false;
  }

  private syncClipStateFromAnalysis() : void {
    if (this.analysis === null) {
      this.clipRanges = {};
      this.activeClipId = null;
      return;
    }

    const validIds : number[] = this.analysis.clips.map((clip : VideoHighlightClip) => clip.id);

    const nextRanges : ClipRangeMap = {};
    for (const clip of this.analysis.clips) {
      const existing = this.clipRanges[clip.id];
      nextRanges[clip.id] = {
        startSeconds: Number((existing?.startSeconds ?? clip.startSeconds).toFixed(3)),
        endSeconds: Number((existing?.endSeconds ?? clip.endSeconds).toFixed(3)),
      };
    }
    this.clipRanges = nextRanges;

    if (this.activeClipId !== null && validIds.includes(this.activeClipId) === false) {
      this.activeClipId = null;
    }

    if (this.activeClipId === null && this.analysis.clips.length > 0) {
      this.activeClipId = this.analysis.clips[0].id;
    }
  }

  private activeClip() : VideoHighlightClip | undefined {
    if (this.analysis === null || this.activeClipId === null) {
      return undefined;
    }
    return this.analysis.clips.find((clip : VideoHighlightClip) => clip.id === this.activeClipId);
  }

  private ensureClipRange(clip : VideoHighlightClip) : void {
    if (this.clipRanges[clip.id] !== undefined) {
      return;
    }

    this.clipRanges = {
      ...this.clipRanges,
      [clip.id]: {
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
      },
    };
  }

  private seekTo(seconds : number) : void {
    const player : HTMLVideoElement | undefined = this.playerRef?.nativeElement;
    if (player === undefined) {
      return;
    }

    const maxDuration : number = this.durationSeconds > 0 ? this.durationSeconds : Number.isFinite(player.duration) ? player.duration : 0;
    const safeSeconds : number = this.clamp(seconds, 0, Math.max(0, maxDuration));
    player.currentTime = safeSeconds;
    this.currentTimeSeconds = safeSeconds;
  }

  private clamp(value : number, min : number, max : number) : number {
    if (Number.isFinite(value) === false) {
      return min;
    }
    return Math.max(min, Math.min(max, value));
  }

  private extractErrorMessage(error : unknown, fallback : string) : string {
    if (error instanceof HttpErrorResponse) {
      const payload : unknown = error.error;
      if (typeof payload === 'object' && payload !== null) {
        const message : unknown = (payload as { message ?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          return message;
        }
      }
      if (typeof payload === 'string' && payload.trim().length > 0) {
        return payload.trim();
      }
      if (Number.isFinite(error.status) && error.status > 0) {
        return `${fallback} (HTTP ${error.status})`;
      }
    }
    return fallback;
  }
}
