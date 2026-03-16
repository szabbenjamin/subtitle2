import { HttpClient, HttpEvent, HttpEventType, HttpResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, firstValueFrom, Observable, of, Subscription, tap } from 'rxjs';
import { VideoDetails, VideoListItem } from '../models/api.models';

interface InitUploadResponse {
  uploadId : string;
  chunkSizeBytes : number;
  totalChunks : number;
}

interface ChunkUploadContext {
  file : File;
  initResponse : InitUploadResponse;
}

interface ListenRequestPayload {
  model : string;
  language : string;
  wordsPerLine : number;
}

export class UploadCancelledError extends Error {
  public constructor(message : string = 'A feltöltés megszakításra került.') {
    super(message);
    this.name = 'UploadCancelledError';
  }
}

export interface ChunkUploadHandle {
  cancel : () => void;
  promise : Promise<VideoDetails>;
}

@Injectable({ providedIn: 'root' })
export class VideoService {
  private readonly chunkSizeBytes : number = 50 * 1024 * 1024;

  public constructor(private readonly httpClient : HttpClient) {}

  /**
   * Videólista lekérése a rejtettség szerint.
   * @param hidden Rejtett videókat kérünk-e.
   * @returns Videólista.
   */
  public list(hidden : boolean) : Observable<VideoListItem[]> {
    return this.httpClient.get<VideoListItem[]>(`/api/videos?hidden=${hidden}`);
  }

  /**
   * Egy videó részletes adatainak lekérése.
   * @param id Videó azonosító.
   * @returns Videó részletei.
   */
  public getById(id : number) : Observable<VideoDetails> {
    return this.httpClient.get<VideoDetails>(`/api/videos/${id}`);
  }

  /**
   * Új videó feltöltése progress eseményekkel.
   * @param file Feltöltendő fájl.
   * @returns HTTP esemény stream.
   */
  public upload(file : File) : Observable<HttpEvent<VideoDetails>> {
    const formData : FormData = new FormData();
    formData.append('file', file);

    return this.httpClient.post<VideoDetails>('/api/videos/upload', formData, {
      reportProgress: true,
      observe: 'events',
    });
  }

  /**
   * Videó feltöltése 50 MB-os chunkokban, megszakítható handle-lel.
   * @param file Feltöltendő fájl.
   * @param onProgress Progress callback (százalék, státusz).
   * @returns Megszakítható feltöltési handle.
   */
  public startChunkedUpload(file : File, onProgress : (percent : number, status : string) => void) : ChunkUploadHandle {
    const cancelState : { value : boolean } = { value: false };
    let uploadId : string | null = null;
    let activeChunkSubscription : Subscription | null = null;
    let didCleanup : boolean = false;

    const cleanupSession = async () : Promise<void> => {
      if (didCleanup === true) {
        return;
      }
      didCleanup = true;
      if (uploadId === null) {
        return;
      }
      await this.cancelChunkSession(uploadId);
    };

    const cancel = () : void => {
      cancelState.value = true;
      if (activeChunkSubscription !== null) {
        activeChunkSubscription.unsubscribe();
        activeChunkSubscription = null;
      }
      void cleanupSession();
    };

    const promise : Promise<VideoDetails> = (async () : Promise<VideoDetails> => {
      const totalChunks : number = Math.max(1, Math.ceil(file.size / this.chunkSizeBytes));
      const initResponse : InitUploadResponse = await firstValueFrom(
        this.httpClient.post<InitUploadResponse>('/api/videos/upload/init', {
          originalFileName: file.name,
          fileSizeBytes: file.size,
          totalChunks,
        }),
      );
      uploadId = initResponse.uploadId;

      const context : ChunkUploadContext = { file, initResponse };
      for (let chunkIndex : number = 0; chunkIndex < initResponse.totalChunks; chunkIndex += 1) {
        if (cancelState.value === true) {
          throw new UploadCancelledError();
        }

        const uploadedChunkBytes : number = await this.uploadSingleChunk({
          context,
          chunkIndex,
          onProgress,
          cancelState,
          setActiveSubscription: (subscription : Subscription | null) => {
            activeChunkSubscription = subscription;
          },
        });
        const chunkPercent : number = Math.min(99, Math.round((uploadedChunkBytes / Math.max(1, file.size)) * 100));
        onProgress(chunkPercent, 'Feltöltés folyamatban...');
      }

      if (cancelState.value === true) {
        throw new UploadCancelledError();
      }

      onProgress(99, 'Feltöltés lezárása...');
      const video : VideoDetails = await firstValueFrom(
        this.httpClient.post<VideoDetails>('/api/videos/upload/complete', {
          uploadId: initResponse.uploadId,
        }),
      );
      onProgress(100, 'Feltöltés kész');
      return video;
    })().catch(async (error : unknown) : Promise<never> => {
      await cleanupSession();
      throw error;
    });

    return { cancel, promise };
  }

  /**
   * Rejtett állapot frissítése.
   * @param id Videó azonosító.
   * @param hidden Új érték.
   * @returns Frissített videó.
   */
  public setHidden(id : number, hidden : boolean) : Observable<VideoDetails> {
    return this.httpClient.patch<VideoDetails>(`/api/videos/${id}/hidden`, { hidden });
  }

  /**
   * Felirat mentése.
   * @param id Videó azonosító.
   * @param subtitleText Mentendő feliratszöveg.
   * @returns Frissített videó.
   */
  public saveSubtitle(id : number, subtitleText : string) : Observable<VideoDetails> {
    return this.httpClient.patch<VideoDetails>(`/api/videos/${id}/subtitle`, { subtitleText });
  }

  /**
   * Videóhoz kiválasztott sablon mentése.
   * @param id Videó azonosító.
   * @param presetId Sablon azonosító.
   * @returns Frissített videó.
   */
  public setSubtitlePreset(id : number, presetId : number) : Observable<VideoDetails> {
    return this.httpClient.patch<VideoDetails>(`/api/videos/${id}/subtitle-preset`, { presetId });
  }

  /**
   * Lehallgatási igény jelölése.
   * @param id Videó azonosító.
   * @returns Frissített videó.
   */
  public requestListen(id : number, payload : ListenRequestPayload) : Observable<VideoDetails> {
    return this.httpClient.post<VideoDetails>(`/api/videos/${id}/listen-request`, payload);
  }

  /**
   * Whisper beállítások mentése egy videóhoz.
   * @param id Videó azonosító.
   * @param payload Whisper beállítások.
   * @returns Frissített videó.
   */
  public updateWhisperSettings(id : number, payload : ListenRequestPayload) : Observable<VideoDetails> {
    return this.httpClient.patch<VideoDetails>(`/api/videos/${id}/whisper-settings`, payload);
  }

  /**
   * Beégetett feliratos videó exportálása.
   * @param id Videó azonosító.
   * @returns Letölthető videó blob.
   */
  public exportBurnedVideo(id : number) : Observable<Blob> {
    return this.httpClient.post(`/api/videos/${id}/export`, {}, { responseType: 'blob' });
  }

  /**
   * Feltöltési session törlése backend oldalon.
   * @param uploadId Feltöltési session azonosító.
   * @returns Nem ad vissza értéket.
   */
  private async cancelChunkSession(uploadId : string) : Promise<void> {
    await firstValueFrom(
      this.httpClient.post('/api/videos/upload/cancel', { uploadId }).pipe(
        catchError(() => {
          return of(null);
        }),
      ),
    );
  }

  /**
   * Egy chunk feltöltése progress figyeléssel.
   * @param params Chunk feltöltési paraméterek.
   * @returns Eddig feltöltött teljes byteszám.
   */
  private async uploadSingleChunk(params : {
    context : ChunkUploadContext;
    chunkIndex : number;
    onProgress : (percent : number, status : string) => void;
    cancelState : { value : boolean };
    setActiveSubscription : (subscription : Subscription | null) => void;
  }) : Promise<number> {
    const { context, chunkIndex, onProgress, cancelState, setActiveSubscription } = params;
    const start : number = chunkIndex * context.initResponse.chunkSizeBytes;
    const end : number = Math.min(context.file.size, start + context.initResponse.chunkSizeBytes);
    const chunkBlob : Blob = context.file.slice(start, end);
    const formData : FormData = this.createChunkFormData(context, chunkIndex, chunkBlob);

    await new Promise<void>((resolve : () => void, reject : (error : unknown) => void) => {
      const subscription : Subscription = this.httpClient
        .post('/api/videos/upload/chunk', formData, { observe: 'events', reportProgress: true })
        .pipe(
          tap((event : HttpEvent<unknown>) => {
            if (event.type === HttpEventType.UploadProgress) {
              const loadedInChunk : number = event.loaded;
              const completedBeforeChunk : number = chunkIndex * context.initResponse.chunkSizeBytes;
              const totalLoaded : number = completedBeforeChunk + loadedInChunk;
              const percent : number = Math.min(99, Math.round((totalLoaded / Math.max(1, context.file.size)) * 100));
              onProgress(percent, 'Feltöltés folyamatban...');
            }
          }),
        )
        .subscribe({
          next: (event : HttpEvent<unknown>) => {
            if (event.type === HttpEventType.Response && event instanceof HttpResponse) {
              setActiveSubscription(null);
              resolve();
            }
          },
          error: (error : unknown) => {
            setActiveSubscription(null);
            if (cancelState.value === true) {
              reject(new UploadCancelledError());
              return;
            }
            reject(error);
          },
        });
      setActiveSubscription(subscription);
    });

    return Math.min(context.file.size, (chunkIndex + 1) * context.initResponse.chunkSizeBytes);
  }

  /**
   * FormData létrehozása az aktuális chunk feltöltéséhez.
   * @param context Feltöltési kontextus.
   * @param chunkIndex Aktuális chunk index.
   * @param chunkBlob A chunk bináris adata.
   * @returns Beküldhető FormData.
   */
  private createChunkFormData(context : ChunkUploadContext, chunkIndex : number, chunkBlob : Blob) : FormData {
    const formData : FormData = new FormData();
    formData.append('chunk', chunkBlob, `${context.file.name}.part${chunkIndex}`);
    formData.append('uploadId', context.initResponse.uploadId);
    formData.append('chunkIndex', String(chunkIndex));
    formData.append('totalChunks', String(context.initResponse.totalChunks));
    return formData;
  }
}
