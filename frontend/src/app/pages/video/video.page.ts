import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject, Subscription, debounceTime, distinctUntilChanged, map } from 'rxjs';
import { SocialTextResult, SubtitlePreset, VideoDetails } from '../../models/api.models';
import { AlertModalService } from '../../services/alert-modal.service';
import { SubtitlePresetService, UpdateSubtitlePresetPayload } from '../../services/subtitle-preset.service';
import { TokenService } from '../../services/token.service';
import { VideoService } from '../../services/video.service';
import { VideoPreviewService } from './video-preview.service';
import { SubtitleCue, SubtitlePresetForm } from './video.types';

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
  public listenRequestState : string = '';
  public whisperSaveState : string = '';
  public whisperModel : string = 'medium';
  public whisperLanguage : string = 'hu';
  public wordsPerLine : number = 7;

  public presets : SubtitlePreset[] = [];
  public selectedPresetId : number | null = null;
  public presetSaveState : string = '';
  public presetAssignState : string = '';
  public exportState : string = '';
  public isExporting : boolean = false;
  public isPresetDetailsOpen : boolean = false;
  public previewSubtitleText : string = '';
  public isGeneratingSocial : boolean = false;
  public socialState : string = '';
  public generatedSocialTitle : string = '';
  public generatedSocialHashtags : string[] = [];
  public generatedSocialCombined : string = '';
  public presetForm : SubtitlePresetForm = this.createDefaultPresetForm();

  public readonly modelOptions : string[] = ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'];
  public readonly languageOptions : Array<{ value : string; label : string }> = [
    { value: 'auto', label: 'Automatikus' },
    { value: 'hu', label: 'Magyar' },
    { value: 'en', label: 'Angol' },
    { value: 'de', label: 'Német' },
    { value: 'fr', label: 'Francia' },
    { value: 'es', label: 'Spanyol' },
  ];
  public readonly fontOptions : string[] = [
    'Arial',
    'Calibri',
    'Times New Roman',
    'Verdana',
    'Helvetica',
    'Georgia',
    'Comic Sans MS',
    'Courier New',
    'Impact',
    'Trebuchet MS',
  ];
  public readonly alignmentOptions : Array<{ value : number; label : string }> = [
    { value: 8, label: 'Fent' },
    { value: 2, label: 'Lent' },
    { value: 5, label: 'Középen' },
    { value: 7, label: 'Bal fent' },
    { value: 9, label: 'Jobb fent' },
    { value: 4, label: 'Bal középen' },
    { value: 6, label: 'Jobb középen' },
    { value: 1, label: 'Bal lent' },
    { value: 3, label: 'Jobb lent' },
  ];

  private readonly autosaveSubject : Subject<string> = new Subject<string>();
  private readonly whisperSettingsSubject : Subject<void> = new Subject<void>();
  private readonly presetSettingsSubject : Subject<void> = new Subject<void>();
  private autosaveSubscription ?: Subscription;
  private whisperSettingsSubscription ?: Subscription;
  private presetSettingsSubscription ?: Subscription;
  private routeSubscription ?: Subscription;
  private processingPollTimer ?: ReturnType<typeof setInterval>;
  private isApplyingPresetForm : boolean = false;
  private previewCues : SubtitleCue[] = [];
  private currentPreviewTimeSeconds : number = 0;

  public constructor(
    private readonly activatedRoute : ActivatedRoute,
    private readonly videoService : VideoService,
    private readonly alertModalService : AlertModalService,
    private readonly subtitlePresetService : SubtitlePresetService,
    private readonly tokenService : TokenService,
    private readonly videoPreviewService : VideoPreviewService,
    private readonly changeDetectorRef : ChangeDetectorRef,
  ) {}

  /**
   * Oldal nyitáskor betöltés és autosave inicializálása.
   * @returns Nem ad vissza értéket.
   */
  public ngOnInit() : void {
    this.tokenService.refreshBalance();
    this.setupAutosave();
    this.setupWhisperSettingsAutosave();
    this.setupPresetAutosave();
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
    if (this.whisperSettingsSubscription !== undefined) {
      this.whisperSettingsSubscription.unsubscribe();
    }
    if (this.presetSettingsSubscription !== undefined) {
      this.presetSettingsSubscription.unsubscribe();
    }
    if (this.routeSubscription !== undefined) {
      this.routeSubscription.unsubscribe();
    }
    if (this.processingPollTimer !== undefined) {
      clearInterval(this.processingPollTimer);
      this.processingPollTimer = undefined;
    }
  }

  /**
   * Felirat szöveg változás eseménykezelő.
   * @returns Nem ad vissza értéket.
   */
  public onSubtitleChange() : void {
    this.saveState = 'Mentés folyamatban...';
    this.rebuildPreviewCues();
    this.autosaveSubject.next(this.subtitleText);
  }

  /**
   * Videó időváltozáskor frissíti az aktív preview feliratot.
   * @param event Video esemény.
   * @returns Nem ad vissza értéket.
   */
  public onVideoTimeUpdate(event : Event) : void {
    const target : EventTarget | null = event.target;
    if (target instanceof HTMLVideoElement) {
      this.currentPreviewTimeSeconds = target.currentTime;
      this.updatePreviewCueForCurrentTime();
    }
  }


  /**
   * Lehallgatás kérés beküldése.
   * @returns Nem ad vissza értéket.
   */
  public requestListen() : void {
    if (this.video === undefined) {
      return;
    }

    if (Number.isFinite(this.wordsPerLine) === false || this.wordsPerLine < 1) {
      this.errorMessage = 'A soronkénti szószám legalább 1 legyen.';
      this.changeDetectorRef.detectChanges();
      return;
    }

    this.listenRequestState = 'Lehallgatási kérés küldése...';
    this.videoService
      .requestListen(this.video.id, {
        model: this.whisperModel,
        language: this.whisperLanguage,
        wordsPerLine: Math.round(this.wordsPerLine),
      })
      .subscribe({
        next: (video : VideoDetails) => {
          this.applyVideoFromServer(video);
          this.listenRequestState = 'Lehallgatási kérés rögzítve.';
          this.tokenService.refreshBalance();
          this.startProcessingPollingIfNeeded();
          this.changeDetectorRef.detectChanges();
        },
        error: (error : unknown) => {
          this.listenRequestState = '';
          this.errorMessage = this.extractErrorMessage(error, 'A lehallgatás jelölése sikertelen.');
          this.alertModalService.open(this.errorMessage, 'Hiba');
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /**
   * Whisper beállítások változásának kezelése.
   * @returns Nem ad vissza értéket.
   */
  public onWhisperSettingsChange() : void {
    this.whisperSaveState = 'Whisper beállítás mentése...';
    this.whisperSettingsSubject.next();
  }

  /**
   * Preset választó változásának kezelése.
   * @returns Nem ad vissza értéket.
   */
  public onPresetSelectionChange() : void {
    if (this.selectedPresetId === null) {
      this.presetAssignState = 'Válassz sablont.';
      return;
    }

    const preset : SubtitlePreset | undefined = this.presets.find((item : SubtitlePreset) => item.id === this.selectedPresetId);
    if (preset !== undefined) {
      this.applyPresetToForm(preset);
    }

    if (this.video === undefined) {
      return;
    }

    this.presetAssignState = 'Sablon hozzárendelése...';
    this.videoService.setSubtitlePreset(this.video.id, this.selectedPresetId).subscribe({
      next: (video : VideoDetails) => {
        this.video = video;
        this.presetAssignState = 'Sablon hozzárendelve.';
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.presetAssignState = 'Sablon hozzárendelési hiba.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Új sablon létrehozása.
   * @returns Nem ad vissza értéket.
   */
  public createPreset() : void {
    const nextIndex : number = this.presets.length + 1;
    this.presetAssignState = 'Új sablon létrehozása...';
    this.subtitlePresetService.create({ name: `Új sablon ${nextIndex}` }).subscribe({
      next: (preset : SubtitlePreset) => {
        this.presets = [preset, ...this.presets];
        this.selectedPresetId = preset.id;
        this.applyPresetToForm(preset);
        this.assignSelectedPresetToVideo();
        this.presetAssignState = 'Sablon létrehozva.';
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.presetAssignState = 'Sablon létrehozási hiba.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Kiválasztott sablon törlése.
   * @returns Nem ad vissza értéket.
   */
  public deleteSelectedPreset() : void {
    if (this.selectedPresetId === null) {
      this.presetAssignState = 'Nincs kiválasztott sablon.';
      return;
    }

    const deletingId : number = this.selectedPresetId;
    this.presetAssignState = 'Sablon törlése...';
    this.subtitlePresetService.remove(deletingId).subscribe({
      next: () => {
        this.presets = this.presets.filter((preset : SubtitlePreset) => preset.id !== deletingId);
        if (this.presets.length === 0) {
          this.selectedPresetId = null;
          this.presetForm = this.createDefaultPresetForm();
          this.presetAssignState = 'Sablon törölve. Hozz létre újat.';
        } else {
          this.selectedPresetId = this.presets[0].id;
          this.applyPresetToForm(this.presets[0]);
          this.assignSelectedPresetToVideo();
          this.presetAssignState = 'Sablon törölve.';
        }
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.presetAssignState = 'Sablon törlési hiba.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Preset mező módosítás eseménykezelő.
   * @returns Nem ad vissza értéket.
   */
  public onPresetFieldChange() : void {
    if (this.isApplyingPresetForm === true) {
      return;
    }

    this.presetSaveState = 'Sablon mentése...';
    this.updatePreviewCueForCurrentTime();
    this.presetSettingsSubject.next();
  }

  /**
   * Exportálás gomb kezelése.
   * @returns Nem ad vissza értéket.
   */
  public onExport() : void {
    if (this.video === undefined) {
      return;
    }
    if (this.hasSubtitleSource() === false) {
      return;
    }

    this.isExporting = true;
    this.exportState = 'Exportálás folyamatban...';
    this.videoService.exportBurnedVideo(this.video.id).subscribe({
      next: (blob : Blob) => {
        const objectUrl : string = URL.createObjectURL(blob);
        const anchor : HTMLAnchorElement = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `${this.buildExportBaseName(this.video?.originalFileName)}-subtitled.mp4`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(objectUrl);

        this.isExporting = false;
        this.exportState = 'Exportálás kész, letöltés elindult.';
        this.tokenService.refreshBalance();
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        void this.handleExportError(error);
      },
    });
  }

  /**
   * Cím + hashtag generálása szövegkönyvből.
   * @returns Nem ad vissza értéket.
   */
  public generateSocialText() : void {
    if (this.video === undefined) {
      return;
    }
    if (this.hasSubtitleSource() === false) {
      return;
    }
    this.isGeneratingSocial = true;
    this.socialState = 'Generálás folyamatban...';
    this.videoService.generateSocialText(this.video.id).subscribe({
      next: (result : SocialTextResult) => {
        this.generatedSocialTitle = result.title;
        this.generatedSocialHashtags = result.hashtags;
        this.generatedSocialCombined = result.combinedText;
        this.isGeneratingSocial = false;
        this.socialState = 'Generálás kész.';
        this.tokenService.refreshBalance();
        this.changeDetectorRef.detectChanges();
      },
      error: (error : unknown) => {
        this.isGeneratingSocial = false;
        this.socialState = '';
        this.errorMessage = this.extractErrorMessage(error, 'A cím + hashtag generálás sikertelen.');
        this.alertModalService.open(this.errorMessage, 'Hiba');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Generált cím + hashtag letöltése txt fájlban.
   * @returns Nem ad vissza értéket.
   */
  public downloadSocialText() : void {
    if (this.generatedSocialCombined.length === 0) {
      return;
    }
    const blob : Blob = new Blob([`${this.generatedSocialCombined}\n`], { type: 'text/plain;charset=utf-8' });
    const url : string = URL.createObjectURL(blob);
    const anchor : HTMLAnchorElement = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.buildExportBaseName(this.video?.originalFileName)}-caption-meta.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
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
   * Whisper beállítások automatikus mentése debounccal.
   * @returns Nem ad vissza értéket.
   */
  private setupWhisperSettingsAutosave() : void {
    this.whisperSettingsSubscription = this.whisperSettingsSubject
      .pipe(debounceTime(700))
      .subscribe(() => {
        if (this.video === undefined) {
          return;
        }

        if (Number.isFinite(this.wordsPerLine) === false || this.wordsPerLine < 1) {
          this.whisperSaveState = 'Mentési hiba';
          this.errorMessage = 'A soronkénti szószám legalább 1 legyen.';
          this.changeDetectorRef.detectChanges();
          return;
        }

        this.videoService
          .updateWhisperSettings(this.video.id, {
            model: this.whisperModel,
            language: this.whisperLanguage,
            wordsPerLine: Math.round(this.wordsPerLine),
          })
          .subscribe({
            next: (video : VideoDetails) => {
              this.video = video;
              this.whisperModel = video.whisperModel;
              this.whisperLanguage = video.whisperLanguage;
              this.wordsPerLine = video.wordsPerLine;
              this.whisperSaveState = 'Whisper beállítás mentve';
              this.changeDetectorRef.detectChanges();
            },
            error: () => {
              this.whisperSaveState = 'Mentési hiba';
              this.errorMessage = 'Nem sikerült menteni a Whisper beállításokat.';
              this.changeDetectorRef.detectChanges();
            },
          });
      });
  }

  /**
   * Preset mezők automatikus mentése debounccal.
   * @returns Nem ad vissza értéket.
   */
  private setupPresetAutosave() : void {
    this.presetSettingsSubscription = this.presetSettingsSubject.pipe(debounceTime(800)).subscribe(() => {
      if (this.selectedPresetId === null) {
        this.presetSaveState = 'Nincs kiválasztott sablon.';
        this.changeDetectorRef.detectChanges();
        return;
      }

      const payload : UpdateSubtitlePresetPayload = this.buildPresetUpdatePayload();
      this.subtitlePresetService.update(this.selectedPresetId, payload).subscribe({
        next: (savedPreset : SubtitlePreset) => {
          this.replacePresetInList(savedPreset);
          this.applyPresetToForm(savedPreset);
          this.presetSaveState = 'Sablon mentve';
          this.changeDetectorRef.detectChanges();
        },
        error: () => {
          this.presetSaveState = 'Sablon mentési hiba';
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
        this.applyVideoFromServer(video);
        this.subtitleText = video.subtitleText;
        this.rebuildPreviewCues();
        this.whisperModel = video.whisperModel;
        this.whisperLanguage = video.whisperLanguage;
        this.wordsPerLine = video.wordsPerLine;
        this.whisperSaveState = '';
        this.startProcessingPollingIfNeeded();
        this.loadPresets(video.subtitlePresetId);
      },
      error: (error : unknown) => {
        this.isLoading = false;
        this.errorMessage = this.extractErrorMessage(error, 'Nem sikerült betölteni a videó oldalát.');
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Presetek betöltése és kiválasztott sablon inicializálása.
   * @param preferredPresetId Videón mentett sablon ID.
   * @returns Nem ad vissza értéket.
   */
  private loadPresets(preferredPresetId : number | null) : void {
    this.subtitlePresetService.list().subscribe({
      next: (presets : SubtitlePreset[]) => {
        this.presets = presets;

        if (presets.length === 0) {
          this.selectedPresetId = null;
          this.presetForm = this.createDefaultPresetForm();
          this.presetAssignState = 'Nincs sablonod. Kattints az Új gombra.';
          this.isLoading = false;
          this.changeDetectorRef.detectChanges();
          return;
        }

        const selected : SubtitlePreset | undefined = presets.find((preset : SubtitlePreset) => preset.id === preferredPresetId) ?? presets[0];
        this.selectedPresetId = selected.id;
        this.applyPresetToForm(selected);
        this.assignSelectedPresetToVideo();
        this.isLoading = false;
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.isLoading = false;
        this.errorMessage = 'Nem sikerült betölteni a sablonokat.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Kiválasztott preset hozzárendelése a videóhoz.
   * @returns Nem ad vissza értéket.
   */
  private assignSelectedPresetToVideo() : void {
    if (this.video === undefined || this.selectedPresetId === null) {
      return;
    }

    if (this.video.subtitlePresetId === this.selectedPresetId) {
      return;
    }

    this.videoService.setSubtitlePreset(this.video.id, this.selectedPresetId).subscribe({
      next: (video : VideoDetails) => {
        this.applyVideoFromServer(video);
        this.presetAssignState = 'Sablon hozzárendelve.';
        this.changeDetectorRef.detectChanges();
      },
      error: () => {
        this.presetAssignState = 'Sablon hozzárendelési hiba.';
        this.changeDetectorRef.detectChanges();
      },
    });
  }

  /**
   * Preset lista elem cseréje mentés után.
   * @param savedPreset Mentett sablon.
   * @returns Nem ad vissza értéket.
   */
  private replacePresetInList(savedPreset : SubtitlePreset) : void {
    this.presets = this.presets.map((preset : SubtitlePreset) => {
      if (preset.id === savedPreset.id) {
        return savedPreset;
      }
      return preset;
    });
  }

  /**
   * Kiválasztott preset adatainak formra töltése.
   * @param preset Kiválasztott sablon.
   * @returns Nem ad vissza értéket.
   */
  private applyPresetToForm(preset : SubtitlePreset) : void {
    this.isApplyingPresetForm = true;
    this.presetForm = {
      name: preset.name,
      fontName: preset.fontName,
      fontSize: preset.fontSize,
      primaryColour: preset.primaryColour,
      secondaryColour: preset.secondaryColour,
      outlineColour: preset.outlineColour,
      backColour: preset.backColour,
      bold: preset.bold,
      italic: preset.italic,
      underline: preset.underline,
      strikeOut: preset.strikeOut,
      scaleX: preset.scaleX,
      scaleY: preset.scaleY,
      spacing: preset.spacing,
      angle: preset.angle,
      borderStyle: preset.borderStyle,
      outline: preset.outline,
      shadow: preset.shadow,
      alignment: preset.alignment,
      marginL: preset.marginL,
      marginR: preset.marginR,
      marginV: preset.marginV,
      encoding: preset.encoding,
    };
    this.isApplyingPresetForm = false;
    this.updatePreviewCueForCurrentTime();
  }

  /**
   * Frissítési payload előállítása a form állapotából.
   * @returns Mentendő payload.
   */
  private buildPresetUpdatePayload() : UpdateSubtitlePresetPayload {
    return {
      name: this.presetForm.name.trim(),
      fontName: this.presetForm.fontName,
      fontSize: Math.round(this.presetForm.fontSize),
      primaryColour: this.presetForm.primaryColour,
      secondaryColour: this.presetForm.secondaryColour,
      outlineColour: this.presetForm.outlineColour,
      backColour: this.presetForm.backColour,
      bold: this.presetForm.bold,
      italic: this.presetForm.italic,
      underline: this.presetForm.underline,
      strikeOut: this.presetForm.strikeOut,
      scaleX: Math.round(this.presetForm.scaleX),
      scaleY: Math.round(this.presetForm.scaleY),
      spacing: Math.round(this.presetForm.spacing),
      angle: Math.round(this.presetForm.angle),
      borderStyle: Math.round(this.presetForm.borderStyle),
      outline: Math.round(this.presetForm.outline),
      shadow: Math.round(this.presetForm.shadow),
      alignment: Math.round(this.presetForm.alignment),
      marginL: Math.round(this.presetForm.marginL),
      marginR: Math.round(this.presetForm.marginR),
      marginV: Math.round(this.presetForm.marginV),
      encoding: this.presetForm.encoding.trim(),
    };
  }

  /**
   * Fájlnévből biztonságos export alapnév.
   * @param fileName Eredeti fájlnév.
   * @returns Tisztított fájlnév.
   */
  private buildExportBaseName(fileName : string | undefined) : string {
    const source : string = (fileName ?? 'video').trim();
    const withoutExt : string = source.replace(/\.[^./\\]+$/, '');
    const safe : string = withoutExt.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
    return safe.length > 0 ? safe : 'video';
  }

  /**
   * Alap preset form modell.
   * @returns Üres/default preset form.
   */
  private createDefaultPresetForm() : SubtitlePresetForm {
    return {
      name: 'Új sablon',
      fontName: 'Arial',
      fontSize: 56,
      primaryColour: '#FFFFFF',
      secondaryColour: '#000000',
      outlineColour: '#000000',
      backColour: '#000000',
      bold: false,
      italic: false,
      underline: false,
      strikeOut: false,
      scaleX: 100,
      scaleY: 100,
      spacing: 0,
      angle: 0,
      borderStyle: 1,
      outline: 2,
      shadow: 2,
      alignment: 2,
      marginL: 30,
      marginR: 30,
      marginV: 30,
      encoding: 'UTF-8',
    };
  }

  /**
   * Szerverről jött videóadat alkalmazása úgy, hogy a folyamat közbeni
   * automatikus feliratmentést ne írjuk felül.
   * @param video Friss videó állapot.
   * @returns Nem ad vissza értéket.
   */
  private applyVideoFromServer(video : VideoDetails) : void {
    this.video = video;
    if (this.saveState !== 'Mentés folyamatban...') {
      this.subtitleText = video.subtitleText;
      this.rebuildPreviewCues();
    }
    this.generatedSocialCombined = video.socialTextCombined ?? '';
    if (this.generatedSocialCombined.length > 0) {
      const lines : string[] = this.generatedSocialCombined.split('\n').map((line : string) => line.trim()).filter((line : string) => line.length > 0);
      this.generatedSocialTitle = lines[0] ?? '';
      const hashtagLine : string = lines.slice(1).join(' ');
      this.generatedSocialHashtags = hashtagLine
        .split(/\s+/)
        .map((item : string) => item.trim())
        .filter((item : string) => item.startsWith('#'));
    } else {
      this.generatedSocialTitle = '';
      this.generatedSocialHashtags = [];
    }
    this.whisperModel = video.whisperModel;
    this.whisperLanguage = video.whisperLanguage;
    this.wordsPerLine = video.wordsPerLine;
  }

  /**
   * Queue/pending állapotban időzített frissítéssel pollolja a videót,
   * hogy elkészüléskor a textarea automatikusan frissüljön.
   * @returns Nem ad vissza értéket.
   */
  private startProcessingPollingIfNeeded() : void {
    if (this.video === undefined) {
      return;
    }

    const shouldPoll : boolean = this.video.processingStatus === 'queued' || this.video.processingStatus === 'pending';
    if (shouldPoll === false) {
      if (this.processingPollTimer !== undefined) {
        clearInterval(this.processingPollTimer);
        this.processingPollTimer = undefined;
      }
      return;
    }

    if (this.processingPollTimer !== undefined) {
      return;
    }

    this.processingPollTimer = setInterval(() => {
      if (this.video === undefined) {
        return;
      }
      this.videoService.getById(this.video.id).subscribe({
        next: (video : VideoDetails) => {
          this.applyVideoFromServer(video);
          if (video.processingStatus === 'idle' && this.processingPollTimer !== undefined) {
            clearInterval(this.processingPollTimer);
            this.processingPollTimer = undefined;
          }
          this.changeDetectorRef.detectChanges();
        },
      });
    }, 3000);
  }

  /**
   * Felhasználóbarát hibaüzenet kinyerése HTTP hibából.
   * @param error Hiba objektum.
   * @returns Megjeleníthető hibaüzenet.
   */
  private extractErrorMessage(error : unknown, fallback : string = 'A művelet sikertelen.') : string {
    if (error instanceof HttpErrorResponse) {
      const parsedMessage : string | null = this.parseMessageFromPayload(error.error);
      if (parsedMessage !== null) {
        return parsedMessage;
      }
      if (error.status === 401) {
        return 'Lejárt bejelentkezés. Jelentkezz be újra.';
      }
      if (error.status === 404) {
        return 'A videó nem található vagy nincs hozzáférésed.';
      }

      if (Number.isFinite(error.status) && error.status > 0) {
        return `${fallback} (HTTP ${error.status})`;
      }
    }
    return fallback;
  }

  /**
   * Export hiba kezelése aszinkron hibaüzenet-feldolgozással (blob támogatás).
   * @param error Hiba objektum.
   */
  private async handleExportError(error : unknown) : Promise<void> {
    this.isExporting = false;
    this.exportState = '';
    this.errorMessage = await this.extractErrorMessageAsync(error, 'Az exportálás sikertelen.');
    this.alertModalService.open(this.errorMessage, 'Hiba');
    this.changeDetectorRef.detectChanges();
  }

  /**
   * Aszinkron hibaüzenet-kivonat, blob payload támogatással.
   * @param error Hiba objektum.
   * @param fallback Alapértelmezett üzenet.
   */
  private async extractErrorMessageAsync(error : unknown, fallback : string) : Promise<string> {
    if (error instanceof HttpErrorResponse) {
      const parsedMessage : string | null = await this.parseMessageFromPayloadAsync(error.error);
      if (parsedMessage !== null) {
        return parsedMessage;
      }
      if (Number.isFinite(error.status) && error.status > 0) {
        return `${fallback} (HTTP ${error.status})`;
      }
    }
    return fallback;
  }

  /**
   * Rekurzív hibaüzenet-feldolgozás szinkron payloadokra.
   * @param payload HTTP payload.
   */
  private parseMessageFromPayload(payload : unknown) : string | null {
    if (typeof payload === 'string' && payload.length > 0) {
      const trimmed : string = payload.trim();
      const looksLikeJson : boolean =
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));

      if (looksLikeJson === true) {
        try {
          return this.parseMessageFromPayload(JSON.parse(trimmed));
        } catch {
          return payload;
        }
      }

      return payload;
    }

    if (Array.isArray(payload) === true && payload.length > 0) {
      const parts : string[] = payload
        .map((item : unknown) => this.parseMessageFromPayload(item))
        .filter((item : string | null) : item is string => item !== null && item.length > 0);
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }

    if (typeof payload === 'object' && payload !== null) {
      const record : Record<string, unknown> = payload as Record<string, unknown>;
      const directMessage : string | null = this.parseMessageFromPayload(record['message']);
      if (directMessage !== null) {
        return directMessage;
      }
      const nestedError : string | null = this.parseMessageFromPayload(record['error']);
      if (nestedError !== null) {
        return nestedError;
      }
    }

    return null;
  }

  /**
   * Rekurzív hibaüzenet-feldolgozás blob payload támogatással.
   * @param payload HTTP payload.
   */
  private async parseMessageFromPayloadAsync(payload : unknown) : Promise<string | null> {
    if (payload instanceof Blob) {
      try {
        const text : string = await payload.text();
        return this.parseMessageFromPayload(text);
      } catch {
        return null;
      }
    }

    return this.parseMessageFromPayload(payload);
  }

  /**
   * SRT-ből preview cue lista újraépítése.
   * @returns Nem ad vissza értéket.
   */
  private rebuildPreviewCues() : void {
    this.previewCues = this.videoPreviewService.parseSrtToCues(this.subtitleText);
    this.updatePreviewCueForCurrentTime();
  }

  /**
   * Aktuális videóidő alapján kiválasztja a látható feliratot.
   * @returns Nem ad vissza értéket.
   */
  private updatePreviewCueForCurrentTime() : void {
    this.previewSubtitleText = this.videoPreviewService.findActiveText(this.previewCues, this.currentPreviewTimeSeconds);
  }

  /**
   * Van-e használható (nem üres) szövegkönyv.
   */
  public hasSubtitleSource() : boolean {
    return this.subtitleText.trim().length > 0;
  }
}
