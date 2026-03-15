import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, rm, stat, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { execFile } from 'child_process';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { VideoEntity } from './entities/video.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadChunkDto } from './dto/upload-chunk.dto';

export interface VideoListItem {
  id : number;
  originalFileName : string;
  durationSeconds : number;
  fileSizeBytes : number;
  createdAt : Date;
  isHidden : boolean;
  processingStatus : string;
}

export interface VideoDetails extends VideoListItem {
  subtitleText : string;
  listenRequested : boolean;
  mediaUrl : string;
}

interface UploadSession {
  ownerId : number;
  originalFileName : string;
  fileSizeBytes : number;
  totalChunks : number;
}

export interface InitUploadResponse {
  uploadId : string;
  chunkSizeBytes : number;
  totalChunks : number;
}

@Injectable()
export class VideosService {
  private readonly chunkSizeBytes : number = 50 * 1024 * 1024;
  private readonly uploadSessions : Map<string, UploadSession> = new Map<string, UploadSession>();
  private readonly chunkTempRoot : string = join(process.cwd(), 'data', 'upload-chunks');
  private readonly uploadsDir : string;

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    private readonly configService : ConfigService,
  ) {
    this.uploadsDir = resolveUploadsDir(this.configService.get<string>('UPLOADS_DIR'));
  }

  /**
   * A kliens által feltöltött fájlból létrehoz egy videó rekordot.
   * @param ownerId A feltöltő user azonosítója.
   * @param file A multer fájl objektum.
   * @returns A létrehozott videó részletes adatai.
   */
  public async createFromUpload(ownerId : number, file : Express.Multer.File) : Promise<VideoDetails> {
    return await this.createFromStoredFile(ownerId, file.originalname, file.filename, file.size);
  }

  /**
   * Létrehoz egy chunkolt feltöltési sessiont.
   * @param ownerId Bejelentkezett user azonosító.
   * @param dto Feltöltés meta adatai.
   * @returns Feltöltés session adatai.
   */
  public async initChunkedUpload(ownerId : number, dto : InitUploadDto) : Promise<InitUploadResponse> {
    const expectedChunks : number = Math.max(1, Math.ceil(dto.fileSizeBytes / this.chunkSizeBytes));
    if (dto.totalChunks !== expectedChunks) {
      throw new BadRequestException('Érvénytelen chunkszám.');
    }

    const uploadId : string = `${ownerId}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
    this.uploadSessions.set(uploadId, {
      ownerId,
      originalFileName: dto.originalFileName,
      fileSizeBytes: dto.fileSizeBytes,
      totalChunks: dto.totalChunks,
    });

    const uploadDir : string = this.resolveUploadDir(uploadId);
    await mkdir(uploadDir, { recursive: true });

    return {
      uploadId,
      chunkSizeBytes: this.chunkSizeBytes,
      totalChunks: dto.totalChunks,
    };
  }

  /**
   * Egy chunk mentése a feltöltési sessionhöz.
   * @param ownerId Bejelentkezett user azonosító.
   * @param dto Chunk meta adatai.
   * @param file Chunk bináris adat.
   * @returns Sikeres mentési válasz.
   */
  public async uploadChunk(ownerId : number, dto : UploadChunkDto, file : Express.Multer.File) : Promise<{ success : boolean }> {
    const session : UploadSession = this.requireUploadSession(ownerId, dto.uploadId);
    if (dto.totalChunks !== session.totalChunks) {
      throw new BadRequestException('A chunkszám nem egyezik a session adataival.');
    }
    if (dto.chunkIndex < 0 || dto.chunkIndex >= session.totalChunks) {
      throw new BadRequestException('Érvénytelen chunk index.');
    }

    const chunkPath : string = this.resolveChunkPath(dto.uploadId, dto.chunkIndex);
    await writeFile(chunkPath, file.buffer);
    return { success: true };
  }

  /**
   * Chunkolt feltöltés lezárása: chunkok összefűzése és videó létrehozása.
   * @param ownerId Bejelentkezett user azonosító.
   * @param dto Lezáró kérés adatai.
   * @returns Létrejött videó részletes adatai.
   */
  public async completeChunkedUpload(ownerId : number, dto : CompleteUploadDto) : Promise<VideoDetails> {
    const session : UploadSession = this.requireUploadSession(ownerId, dto.uploadId);
    const uploadDir : string = this.resolveUploadDir(dto.uploadId);

    for (let index : number = 0; index < session.totalChunks; index += 1) {
      const chunkPath : string = this.resolveChunkPath(dto.uploadId, index);
      try {
        await access(chunkPath);
      } catch {
        throw new BadRequestException(`Hiányzó chunk: ${index + 1}/${session.totalChunks}`);
      }
    }

    await mkdir(this.uploadsDir, { recursive: true });
    const extension : string = extname(session.originalFileName);
    const storageFileName : string = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}${extension}`;
    const finalPath : string = join(this.uploadsDir, storageFileName);
    const writer = createWriteStream(finalPath, { flags: 'w' });

    for (let index : number = 0; index < session.totalChunks; index += 1) {
      const chunkPath : string = this.resolveChunkPath(dto.uploadId, index);
      await this.appendChunkToStream(chunkPath, writer);
    }

    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      writer.end((error ?: Error | null) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const fileStat = await stat(finalPath);
    const video : VideoDetails = await this.createFromStoredFile(
      ownerId,
      session.originalFileName,
      storageFileName,
      Number(fileStat.size),
    );

    this.uploadSessions.delete(dto.uploadId);
    await rm(uploadDir, { recursive: true, force: true });

    return video;
  }

  /**
   * Feltöltési session megszakítása és takarítása.
   * @param ownerId Bejelentkezett user azonosító.
   * @param dto Lezáró kérés adatai.
   * @returns Siker jelzés.
   */
  public async cancelChunkedUpload(ownerId : number, dto : CompleteUploadDto) : Promise<{ success : boolean }> {
    const session : UploadSession | undefined = this.uploadSessions.get(dto.uploadId);
    if (session === undefined) {
      return { success: true };
    }
    if (session.ownerId !== ownerId) {
      throw new BadRequestException('Nincs jogosultság ehhez a feltöltési sessionhöz.');
    }

    this.uploadSessions.delete(dto.uploadId);
    const uploadDir : string = this.resolveUploadDir(dto.uploadId);
    await rm(uploadDir, { recursive: true, force: true });
    return { success: true };
  }

  /**
   * Visszaadja a user videólistáját.
   * @param ownerId User azonosító.
   * @param hidden Rejtett lista kell-e.
   * @returns Rendezett videólista.
   */
  public async list(ownerId : number, hidden : boolean) : Promise<VideoListItem[]> {
    const videos : VideoEntity[] = await this.videosRepository.find({
      where: {
        ownerId,
        isHidden: hidden,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return videos.map((video : VideoEntity) => this.toVideoListItem(video));
  }

  /**
   * Visszaadja egy adott videó részletes adatait.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Videó részletei.
   */
  public async getById(ownerId : number, videoId : number) : Promise<VideoDetails> {
    const video : VideoEntity | null = await this.videosRepository.findOne({
      where: {
        id: videoId,
        ownerId,
      },
    });

    if (video === null) {
      throw new NotFoundException('A videó nem található.');
    }

    return this.toVideoDetails(video);
  }

  /**
   * Átállítja a videó rejtett állapotát.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param hidden Új rejtett állapot.
   * @returns Módosított videó.
   */
  public async updateHidden(ownerId : number, videoId : number, hidden : boolean) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    video.isHidden = hidden;
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * Frissíti az SRT szöveget.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param subtitleText Új felirat szöveg.
   * @returns Módosított videó.
   */
  public async updateSubtitle(ownerId : number, videoId : number, subtitleText : string) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    video.subtitleText = subtitleText;
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * Lehallgatási igény jelölése.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Módosított videó.
   */
  public async requestListen(ownerId : number, videoId : number) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    video.listenRequested = true;
    video.processingStatus = 'queued';
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * Ellenőrzi, hogy a videó az adott useré.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Videó entitás.
   */
  private async requireOwnedVideo(ownerId : number, videoId : number) : Promise<VideoEntity> {
    const video : VideoEntity | null = await this.videosRepository.findOne({
      where: {
        id: videoId,
        ownerId,
      },
    });

    if (video === null) {
      throw new NotFoundException('A videó nem található.');
    }

    return video;
  }

  /**
   * Lista elem DTO.
   * @param video Videó entitás.
   * @returns Lista elem.
   */
  private toVideoListItem(video : VideoEntity) : VideoListItem {
    return {
      id: video.id,
      originalFileName: video.originalFileName,
      durationSeconds: video.durationSeconds,
      fileSizeBytes: video.fileSizeBytes,
      createdAt: video.createdAt,
      isHidden: video.isHidden,
      processingStatus: video.processingStatus,
    };
  }

  /**
   * Részletes videó DTO.
   * @param video Videó entitás.
   * @returns Részletes objektum.
   */
  private toVideoDetails(video : VideoEntity) : VideoDetails {
    return {
      ...this.toVideoListItem(video),
      subtitleText: video.subtitleText,
      listenRequested: video.listenRequested,
      mediaUrl: `/api/uploads/${video.storageFileName}`,
    };
  }

  /**
   * Sessionhöz tartozó chunk könyvtár útvonala.
   * @param uploadId Feltöltés azonosító.
   * @returns Könyvtár elérési út.
   */
  private resolveUploadDir(uploadId : string) : string {
    return join(this.chunkTempRoot, uploadId);
  }

  /**
   * Sessionhöz tartozó chunk fájl útvonala.
   * @param uploadId Feltöltés azonosító.
   * @param chunkIndex Chunk sorszám.
   * @returns Fájl elérési út.
   */
  private resolveChunkPath(uploadId : string, chunkIndex : number) : string {
    return join(this.resolveUploadDir(uploadId), `${chunkIndex}.part`);
  }

  /**
   * Ellenőrzi és visszaadja a feltöltési sessiont.
   * @param ownerId User azonosító.
   * @param uploadId Session azonosító.
   * @returns Feltöltési session.
   */
  private requireUploadSession(ownerId : number, uploadId : string) : UploadSession {
    const session : UploadSession | undefined = this.uploadSessions.get(uploadId);
    if (session === undefined) {
      throw new BadRequestException('A feltöltési session nem található.');
    }
    if (session.ownerId !== ownerId) {
      throw new BadRequestException('Nincs jogosultság ehhez a feltöltési sessionhöz.');
    }
    return session;
  }

  /**
   * Chunk fájl hozzáfűzése egy nyitott write streamhez.
   * @param chunkPath Chunk fájl útvonala.
   * @param writer Kimeneti stream.
   * @returns Nem ad vissza értéket.
   */
  private async appendChunkToStream(chunkPath : string, writer : NodeJS.WritableStream) : Promise<void> {
    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      const reader = createReadStream(chunkPath);
      reader.on('error', reject);
      reader.on('end', resolve);
      reader.pipe(writer, { end: false });
    });
  }

  /**
   * Közös videó létrehozás tárolt fájlból.
   * @param ownerId Feltöltő user azonosítója.
   * @param originalFileName Eredeti fájlnév.
   * @param storageFileName Szerveren tárolt fájlnév.
   * @param fileSizeBytes Fájlméret byte-ban.
   * @returns Létrejött videó részletes adatai.
   */
  private async createFromStoredFile(
    ownerId : number,
    originalFileName : string,
    storageFileName : string,
    fileSizeBytes : number,
  ) : Promise<VideoDetails> {
    const fullPath : string = join(this.uploadsDir, storageFileName);
    const durationSeconds : number = await this.detectDurationSeconds(fullPath);
    const createdVideo : VideoEntity = this.videosRepository.create({
      ownerId,
      originalFileName,
      storageFileName,
      fileSizeBytes,
      durationSeconds,
      isHidden: false,
      listenRequested: false,
      subtitleText: '',
      processingStatus: 'pending',
    });

    const savedVideo : VideoEntity = await this.videosRepository.save(createdVideo);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * Videó hosszának meghatározása másodpercben.
   * @param inputPath Elemzendő média fájl útvonala.
   * @returns Videó hossza másodpercben.
   */
  private async detectDurationSeconds(inputPath : string) : Promise<number> {
    const ffprobeDuration : number | null = await this.detectDurationWithFfprobe(inputPath);
    if (ffprobeDuration !== null) {
      return ffprobeDuration;
    }

    const ffmpegDuration : number | null = await this.detectDurationWithFfmpeg(inputPath);
    if (ffmpegDuration !== null) {
      return ffmpegDuration;
    }

    return 0;
  }

  /**
   * ffprobe használata a média hosszának kiolvasására.
   * @param inputPath Elemzendő média fájl útvonala.
   * @returns Másodperc vagy null ha sikertelen.
   */
  private async detectDurationWithFfprobe(inputPath : string) : Promise<number | null> {
    const output : string | null = await this.execTool('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);

    if (output === null) {
      return null;
    }

    const parsed : number = Number(output.trim());
    if (Number.isFinite(parsed) === false || parsed <= 0) {
      return null;
    }

    return Math.max(0, Math.round(parsed));
  }

  /**
   * ffmpeg stderr alapján próbálja kinyerni a média hosszát.
   * @param inputPath Elemzendő média fájl útvonala.
   * @returns Másodperc vagy null ha sikertelen.
   */
  private async detectDurationWithFfmpeg(inputPath : string) : Promise<number | null> {
    const output : string | null = await this.execTool('ffmpeg', ['-i', inputPath]);
    if (output === null) {
      return null;
    }

    const match : RegExpMatchArray | null = output.match(/Duration:\\s*(\\d{2}):(\\d{2}):(\\d{2}(?:\\.\\d+)?)/i);
    if (match === null) {
      return null;
    }

    const hours : number = Number(match[1]);
    const minutes : number = Number(match[2]);
    const seconds : number = Number(match[3]);
    if (Number.isFinite(hours) === false || Number.isFinite(minutes) === false || Number.isFinite(seconds) === false) {
      return null;
    }

    return Math.max(0, Math.round(hours * 3600 + minutes * 60 + seconds));
  }

  /**
   * Külső parancs futtatása és kimenet visszaadása.
   * @param command Futtatandó parancs.
   * @param args Parancs argumentumok.
   * @returns stdout/stderr vagy null hiba esetén.
   */
  private async execTool(command : string, args : string[]) : Promise<string | null> {
    return await new Promise<string | null>((resolve : (value : string | null) => void) => {
      execFile(command, args, { timeout: 20_000 }, (error : Error | null, stdout : string, stderr : string) => {
        if (error !== null) {
          const fallbackOutput : string = `${stdout}\n${stderr}`.trim();
          if (fallbackOutput.length > 0) {
            resolve(fallbackOutput);
            return;
          }
          resolve(null);
          return;
        }

        const output : string = `${stdout}\n${stderr}`.trim();
        resolve(output.length > 0 ? output : null);
      });
    });
  }

}
