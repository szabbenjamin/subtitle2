import { HttpClient, HttpEvent, HttpEventType, HttpResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, firstValueFrom, Observable, of, Subscription, tap } from 'rxjs';
import { VideoDetails, VideoListItem } from '../models/api.models';

interface InitUploadResponse {
  uploadId : string;
  chunkSizeBytes : number;
  totalChunks : number;
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

      for (let chunkIndex : number = 0; chunkIndex < initResponse.totalChunks; chunkIndex += 1) {
        if (cancelState.value === true) {
          throw new UploadCancelledError();
        }

        const start : number = chunkIndex * initResponse.chunkSizeBytes;
        const end : number = Math.min(file.size, start + initResponse.chunkSizeBytes);
        const chunkBlob : Blob = file.slice(start, end);
        const formData : FormData = new FormData();
        formData.append('chunk', chunkBlob, `${file.name}.part${chunkIndex}`);
        formData.append('uploadId', initResponse.uploadId);
        formData.append('chunkIndex', String(chunkIndex));
        formData.append('totalChunks', String(initResponse.totalChunks));

        await new Promise<void>((resolve : () => void, reject : (error : unknown) => void) => {
          activeChunkSubscription = this.httpClient
            .post('/api/videos/upload/chunk', formData, { observe: 'events', reportProgress: true })
            .pipe(
              tap((event : HttpEvent<unknown>) => {
                if (event.type === HttpEventType.UploadProgress) {
                  const loadedInChunk : number = event.loaded;
                  const completedBeforeChunk : number = chunkIndex * initResponse.chunkSizeBytes;
                  const totalLoaded : number = completedBeforeChunk + loadedInChunk;
                  const percent : number = Math.min(99, Math.round((totalLoaded / Math.max(1, file.size)) * 100));
                  const status : string = `Feltöltés: ${chunkIndex + 1}/${initResponse.totalChunks} blokk`;
                  onProgress(percent, status);
                }
              }),
            )
            .subscribe({
              next: (event : HttpEvent<unknown>) => {
                if (event.type === HttpEventType.Response && event instanceof HttpResponse) {
                  activeChunkSubscription = null;
                  resolve();
                }
              },
              error: (error : unknown) => {
                activeChunkSubscription = null;
                if (cancelState.value === true) {
                  reject(new UploadCancelledError());
                  return;
                }
                reject(error);
              },
            });
        });

        const completedBytes : number = Math.min(file.size, (chunkIndex + 1) * initResponse.chunkSizeBytes);
        const chunkPercent : number = Math.min(99, Math.round((completedBytes / Math.max(1, file.size)) * 100));
        onProgress(chunkPercent, `Blokk kész: ${chunkIndex + 1}/${initResponse.totalChunks}`);
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
   * Lehallgatási igény jelölése.
   * @param id Videó azonosító.
   * @returns Frissített videó.
   */
  public requestListen(id : number) : Observable<VideoDetails> {
    return this.httpClient.post<VideoDetails>(`/api/videos/${id}/listen-request`, {});
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
}
