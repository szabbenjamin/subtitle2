import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join } from 'path';
import { ChildProcess, execFile, spawn } from 'child_process';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import {
  calculateListenTokens,
  TOKEN_COST_EXPORT,
  TOKEN_COST_SOCIAL_TEXT,
  TOKEN_COST_UPLOAD,
  TOKEN_ENTRY_TYPE_EXPORT,
  TOKEN_ENTRY_TYPE_LISTEN,
  TOKEN_ENTRY_TYPE_SOCIAL_TEXT,
  TOKEN_ENTRY_TYPE_UPLOAD,
} from '../tokens/tokens.constants';
import { TokensService } from '../tokens/tokens.service';
import { UserEntity } from '../users/entities/user.entity';
import { VideoHighlightClipEntity } from './entities/video-highlight-clip.entity';
import { VideoEntity } from './entities/video.entity';
import { ExportedVideoFile, VideoExportService } from './video-export.service';
import { SocialTextResult, VideoSocialService } from './video-social.service';
import { isAllowedMediaExtension, isAllowedMediaMimeType } from './video-file-validation.util';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadChunkDto } from './dto/upload-chunk.dto';
import { WhisperSettingsDto } from './dto/whisper-settings.dto';

export interface VideoListItem {
  id : number;
  originalFileName : string;
  durationSeconds : number;
  fileSizeBytes : number;
  createdAt : Date;
  isHidden : boolean;
  processingStatus : string;
  thumbnailUrl : string;
}

export interface VideoDetails extends VideoListItem {
  subtitleText : string;
  listenRequested : boolean;
  mediaUrl : string;
  subtitlePresetId : number | null;
  socialTextCombined : string;
  whisperModel : string;
  whisperLanguage : string;
  wordsPerLine : number;
}

interface UploadSession {
  ownerId : number;
  originalFileName : string;
  fileSizeBytes : number;
  totalChunks : number;
}

interface ProbedMediaStream {
  codecName : string | null;
  bitRate : number | null;
}

interface ProbedMediaFile {
  formatNames : string[];
  formatBitRate : number | null;
  videoStream : ProbedMediaStream | null;
  audioStream : ProbedMediaStream | null;
}

interface StoredMediaFile {
  storageFileName : string;
  fileSizeBytes : number;
}

export interface InitUploadResponse {
  uploadId : string;
  chunkSizeBytes : number;
  totalChunks : number;
}

type YoutubeImportStatus = 'queued' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled';

interface YoutubeImportTask {
  id : string;
  ownerId : number;
  url : string;
  displayTitle : string;
  status : YoutubeImportStatus;
  progressPercent : number;
  stageMessage : string;
  errorMessage : string;
  videoId : number | null;
  cancelRequested : boolean;
  startedAt : Date;
  updatedAt : Date;
  downloadProcess : ChildProcess | null;
}

export interface YoutubeImportStartResponse {
  importId : string;
  displayTitle : string;
  status : YoutubeImportStatus;
  progressPercent : number;
  stageMessage : string;
}

export interface YoutubeImportStatusResponse {
  id : string;
  displayTitle : string;
  status : YoutubeImportStatus;
  progressPercent : number;
  stageMessage : string;
  errorMessage : string;
  videoId : number | null;
  updatedAt : Date;
}

@Injectable()
export class VideosService {
  private readonly logger : Logger = new Logger(VideosService.name);
  private readonly whisperModel : string = 'turbo';
  private readonly defaultWhisperLanguage : string = 'hu';
  private readonly defaultWordsPerLine : number = 7;
  private readonly uploadTranscodePreset : string = 'superfast';
  private readonly uploadVideoBitRateMultiplier : number = 1.3;
  private readonly uploadAudioBitRateMultiplier : number = 1.15;
  private readonly chunkSizeBytes : number = 10 * 1024 * 1024;
  private readonly uploadSessions : Map<string, UploadSession> = new Map<string, UploadSession>();
  private readonly youtubeImportTasks : Map<string, YoutubeImportTask> = new Map<string, YoutubeImportTask>();
  private readonly chunkTempRoot : string = join(process.cwd(), 'data', 'upload-chunks');
  private readonly uploadsDir : string;

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    @InjectRepository(VideoHighlightClipEntity)
    private readonly videoHighlightClipsRepository : Repository<VideoHighlightClipEntity>,
    @InjectRepository(SubtitlePresetEntity)
    private readonly presetsRepository : Repository<SubtitlePresetEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepository : Repository<UserEntity>,
    private readonly configService : ConfigService,
    private readonly videoExportService : VideoExportService,
    private readonly videoSocialService : VideoSocialService,
    private readonly tokensService : TokensService,
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
    this.logger.log(
      `Direkt feltöltés indult. ownerId=${ownerId}, originalName="${file.originalname}", size=${file.size}, mime="${file.mimetype}", tempFile="${file.filename}"`,
    );
    this.assertAllowedMediaFile(file.originalname, file.mimetype);
    await this.tokensService.charge(
      ownerId,
      TOKEN_COST_UPLOAD,
      TOKEN_ENTRY_TYPE_UPLOAD,
      `Videó feltöltés: ${file.originalname}`,
    );
    let finalStorageFileName : string = file.filename;
    try {
      const normalized : StoredMediaFile = await this.normalizeUploadedMediaFile(file.filename);
      finalStorageFileName = normalized.storageFileName;
      const createdVideo : VideoDetails = await this.createFromStoredFile(
        ownerId,
        file.originalname,
        normalized.storageFileName,
        normalized.fileSizeBytes,
      );
      this.logger.log(
        `Direkt feltöltés kész. ownerId=${ownerId}, videoId=${createdVideo.id}, stored="${normalized.storageFileName}", converted=${
          normalized.storageFileName !== file.filename
        }, durationSec=${createdVideo.durationSeconds}`,
      );
      return createdVideo;
    } catch (error : unknown) {
      if (finalStorageFileName !== file.filename) {
        const normalizedPath : string = join(this.uploadsDir, finalStorageFileName);
        await rm(normalizedPath, { force: true });
      }
      const message : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.error(`Direkt feltöltés hiba. ownerId=${ownerId}, file="${file.originalname}", details=${message}`);
      throw error;
    }
  }

  /**
   * Létrehoz egy chunkolt feltöltési sessiont.
   * @param ownerId Bejelentkezett user azonosító.
   * @param dto Feltöltés meta adatai.
   * @returns Feltöltés session adatai.
   */
  public async initChunkedUpload(ownerId : number, dto : InitUploadDto) : Promise<InitUploadResponse> {
    this.assertAllowedMediaFile(dto.originalFileName, dto.mimeType);
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
    this.logger.log(
      `Chunk feltöltés init. ownerId=${ownerId}, uploadId=${uploadId}, file="${dto.originalFileName}", size=${dto.fileSizeBytes}, chunks=${dto.totalChunks}`,
    );

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
    if (dto.chunkIndex === 0 || dto.chunkIndex + 1 === session.totalChunks || (dto.chunkIndex + 1) % 10 === 0) {
      this.logger.log(
        `Chunk érkezett. ownerId=${ownerId}, uploadId=${dto.uploadId}, chunk=${dto.chunkIndex + 1}/${session.totalChunks}, bytes=${file.size}`,
      );
    }
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
    this.logger.log(
      `Chunk feltöltés lezárás indult. ownerId=${ownerId}, uploadId=${dto.uploadId}, file="${session.originalFileName}", chunks=${session.totalChunks}`,
    );

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
    const storageFileName : string = this.generateStorageFileName(extension);
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

    let normalizedStorage : StoredMediaFile | null = null;
    try {
      normalizedStorage = await this.normalizeUploadedMediaFile(storageFileName);
      await this.tokensService.charge(
        ownerId,
        TOKEN_COST_UPLOAD,
        TOKEN_ENTRY_TYPE_UPLOAD,
        `Videó feltöltés: ${session.originalFileName}`,
      );
      const video : VideoDetails = await this.createFromStoredFile(
        ownerId,
        session.originalFileName,
        normalizedStorage.storageFileName,
        normalizedStorage.fileSizeBytes,
      );

      this.uploadSessions.delete(dto.uploadId);
      await rm(uploadDir, { recursive: true, force: true });
      this.logger.log(
        `Chunk feltöltés lezárva. ownerId=${ownerId}, uploadId=${dto.uploadId}, videoId=${video.id}, stored="${normalizedStorage.storageFileName}", converted=${
          normalizedStorage.storageFileName !== storageFileName
        }, durationSec=${video.durationSeconds}`,
      );

      return video;
    } catch (error : unknown) {
      if (normalizedStorage !== null) {
        await rm(join(this.uploadsDir, normalizedStorage.storageFileName), { force: true });
      }
      await rm(finalPath, { force: true });
      this.uploadSessions.delete(dto.uploadId);
      await rm(uploadDir, { recursive: true, force: true });
      const message : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.error(`Chunk feltöltés lezárási hiba. ownerId=${ownerId}, uploadId=${dto.uploadId}, details=${message}`);
      throw error;
    }
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
    this.logger.warn(`Chunk feltöltés megszakítva. ownerId=${ownerId}, uploadId=${dto.uploadId}, file="${session.originalFileName}"`);
    return { success: true };
  }

  /**
   * YouTube URL alapú import indítása yt-dlp-vel.
   * @param ownerId Bejelentkezett user azonosító.
   * @param youtubeUrl YouTube videó URL.
   * @returns Import azonosító és kezdő státusz.
   */
  public async startYoutubeImport(ownerId : number, youtubeUrl : string) : Promise<YoutubeImportStartResponse> {
    const normalizedUrl : string = this.normalizeYoutubeUrl(youtubeUrl);
    const importId : string = `yt-${ownerId}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
    const now : Date = new Date();
    const task : YoutubeImportTask = {
      id: importId,
      ownerId,
      url: normalizedUrl,
      displayTitle: this.deriveYoutubeFallbackTitle(normalizedUrl),
      status: 'queued',
      progressPercent: 0,
      stageMessage: 'YouTube letöltés előkészítése...',
      errorMessage: '',
      videoId: null,
      cancelRequested: false,
      startedAt: now,
      updatedAt: now,
      downloadProcess: null,
    };

    this.youtubeImportTasks.set(importId, task);
    this.pruneYoutubeImportTasks();
    this.logger.log(`YouTube import queuezva. ownerId=${ownerId}, importId=${importId}, url="${normalizedUrl}"`);
    void this.processYoutubeImport(importId);
    return this.toYoutubeImportStartResponse(task);
  }

  /**
   * YouTube import státusz lekérése.
   * @param ownerId Bejelentkezett user azonosító.
   * @param importId Import azonosító.
   * @returns Aktuális státusz.
   */
  public getYoutubeImportStatus(ownerId : number, importId : string) : YoutubeImportStatusResponse {
    const task : YoutubeImportTask = this.requireOwnedYoutubeImportTask(ownerId, importId);
    return this.toYoutubeImportStatusResponse(task);
  }

  /**
   * YouTube import megszakítása.
   * @param ownerId Bejelentkezett user azonosító.
   * @param importId Import azonosító.
   * @returns Siker jelzés.
   */
  public cancelYoutubeImport(ownerId : number, importId : string) : { success : boolean } {
    const task : YoutubeImportTask = this.requireOwnedYoutubeImportTask(ownerId, importId);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return { success: true };
    }

    task.cancelRequested = true;
    this.updateYoutubeImportTask(task, {
      status: 'cancelled',
      stageMessage: 'YouTube letöltés megszakítás alatt...',
    });
    if (task.downloadProcess !== null && task.downloadProcess.killed === false) {
      task.downloadProcess.kill('SIGTERM');
    }
    this.logger.warn(`YouTube import megszakítás kérve. ownerId=${ownerId}, importId=${importId}`);
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

    return await this.toVideoDetails(video);
  }

  /**
   * Videó törlése: DB rekord + fizikai fájl eltávolítása.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Siker jelzés.
   */
  public async remove(ownerId : number, videoId : number) : Promise<{ success : boolean }> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    const mediaPath : string = join(this.uploadsDir, video.storageFileName);
    const thumbnailPath : string = video.thumbnailFileName.length > 0 ? join(this.uploadsDir, video.thumbnailFileName) : '';
    const highlightClips : VideoHighlightClipEntity[] = await this.videoHighlightClipsRepository.find({
      where: {
        ownerId,
        videoId,
      },
      select: {
        id: true,
        screenshotFileName: true,
      },
    });
    const screenshotPaths : string[] = Array.from(
      new Set(
        highlightClips
          .map((clip : VideoHighlightClipEntity) => clip.screenshotFileName.trim())
          .filter((fileName : string) => fileName.length > 0)
          .map((fileName : string) => join(this.uploadsDir, fileName)),
      ),
    );

    await this.videosRepository.remove(video);
    await rm(mediaPath, { force: true });
    if (thumbnailPath.length > 0) {
      await rm(thumbnailPath, { force: true });
    }
    for (const screenshotPath of screenshotPaths) {
      await rm(screenshotPath, { force: true });
    }
    this.logger.warn(`Videó törölve. ownerId=${ownerId}, videoId=${videoId}, stored="${video.storageFileName}"`);

    return { success: true };
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
    return await this.toVideoDetails(savedVideo);
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
    return await this.toVideoDetails(savedVideo);
  }

  /**
   * Videóhoz kiválasztott felirat sablon mentése.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param presetId Sablon azonosító.
   * @returns Módosított videó.
   */
  public async updateVideoPreset(ownerId : number, videoId : number, presetId : number) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    const preset : SubtitlePresetEntity | null = await this.presetsRepository.findOne({
      where: {
        id: presetId,
        ownerId,
      },
    });
    if (preset === null) {
      throw new NotFoundException('A sablon nem található.');
    }

    video.subtitlePresetId = preset.id;
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return await this.toVideoDetails(savedVideo);
  }

  /**
   * Kompatibilitási whisper settings mentés régi videó-specifikus endpointhoz.
   * A beállítások user szinten kerülnek mentésre.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param dto Mentendő whisper beállítások.
   * @returns Videó részletek user whisper beállításokkal.
   */
  public async updateWhisperSettings(ownerId : number, videoId : number, dto : WhisperSettingsDto) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    await this.saveUserWhisperSettings(ownerId, dto.language, dto.wordsPerLine);
    return await this.toVideoDetails(video);
  }

  /**
   * Lehallgatási igény jelölése.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Módosított videó.
   */
  public async requestListen(ownerId : number, videoId : number) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    if (video.processingStatus === 'queued' || video.processingStatus === 'pending') {
      throw new BadRequestException('A videó már feldolgozás alatt van vagy várólistán van.');
    }
    const requiredTokens : number = calculateListenTokens(video.durationSeconds);
    await this.tokensService.charge(
      ownerId,
      requiredTokens,
      TOKEN_ENTRY_TYPE_LISTEN,
      `Whisper lehallgatás: ${video.originalFileName} (${requiredTokens} token)`,
    );
    video.listenRequested = true;
    video.processingStatus = 'queued';
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    this.logger.log(
      `Whisper queue kérés mentve. ownerId=${ownerId}, videoId=${videoId}, durationSec=${video.durationSeconds}, tokenCost=${requiredTokens}`,
    );
    return await this.toVideoDetails(savedVideo);
  }

  /**
   * SRT videóra égetése ASS stílussal.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Elkészült videófájl elérési adatai.
   */
  public async exportBurnedVideo(ownerId : number, videoId : number) : Promise<ExportedVideoFile> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    if (video.subtitlePresetId === null || video.subtitlePresetId === undefined) {
      throw new BadRequestException('Nincs sablon kiválasztva a videóhoz.');
    }

    const preset : SubtitlePresetEntity | null = await this.presetsRepository.findOne({
      where: {
        id: video.subtitlePresetId,
        ownerId,
      },
    });
    if (preset === null) {
      throw new NotFoundException('A kiválasztott sablon nem található.');
    }

    await this.tokensService.charge(
      ownerId,
      TOKEN_COST_EXPORT,
      TOKEN_ENTRY_TYPE_EXPORT,
      `Videó exportálás: ${video.originalFileName}`,
    );
    return await this.videoExportService.exportBurnedVideo(ownerId, video, preset, this.uploadsDir);
  }

  /**
   * Cím + hashtag generálás a videó szövegkönyvéből.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Generált marketing szöveg.
   */
  public async generateSocialText(ownerId : number, videoId : number) : Promise<SocialTextResult> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    await this.tokensService.charge(
      ownerId,
      TOKEN_COST_SOCIAL_TEXT,
      TOKEN_ENTRY_TYPE_SOCIAL_TEXT,
      `Cím + hashtag generálás: ${video.originalFileName}`,
    );
    const generated : SocialTextResult = await this.videoSocialService.generateFromSubtitle(video);
    video.socialTextCombined = generated.combinedText;
    await this.videosRepository.save(video);
    return generated;
  }

  private async processYoutubeImport(importId : string) : Promise<void> {
    const task : YoutubeImportTask | undefined = this.youtubeImportTasks.get(importId);
    if (task === undefined) {
      return;
    }

    const storagePrefix : string = `${task.id}-`;
    try {
      this.updateYoutubeImportTask(task, {
        status: 'downloading',
        progressPercent: 1,
        stageMessage: 'YouTube letöltés folyamatban...',
        errorMessage: '',
      });
      const ytdlpCommand : string = await this.resolveYtDlpCommand();
      this.logger.log(`YouTube import letöltő parancs: "${ytdlpCommand}"`);
      const outputTemplate : string = join(this.uploadsDir, `${storagePrefix}%(title).120B.%(ext)s`);
      await this.runYtDlpDownload(task, ytdlpCommand, outputTemplate);
      this.assertYoutubeImportNotCancelled(task);

      this.updateYoutubeImportTask(task, {
        status: 'processing',
        progressPercent: 96,
        stageMessage: 'Feldolgozás folyamatban...',
      });

      const downloadedStorageFileName : string = await this.findYoutubeDownloadedStorageFileName(storagePrefix);
      this.assertYoutubeImportNotCancelled(task);

      const originalFileName : string = this.deriveOriginalFileNameFromYoutubeDownload(downloadedStorageFileName, storagePrefix);
      this.assertYoutubeImportNotCancelled(task);
      await this.tokensService.charge(
        task.ownerId,
        TOKEN_COST_UPLOAD,
        TOKEN_ENTRY_TYPE_UPLOAD,
        `Videó feltöltés (YouTube): ${originalFileName}`,
      );

      const normalized : StoredMediaFile = await this.normalizeUploadedMediaFile(downloadedStorageFileName);
      this.assertYoutubeImportNotCancelled(task);
      const createdVideo : VideoDetails = await this.createFromStoredFile(
        task.ownerId,
        originalFileName,
        normalized.storageFileName,
        normalized.fileSizeBytes,
      );

      this.updateYoutubeImportTask(task, {
        status: 'completed',
        progressPercent: 100,
        stageMessage: 'YouTube letöltés kész.',
        errorMessage: '',
        videoId: createdVideo.id,
      });
      this.logger.log(`YouTube import kész. ownerId=${task.ownerId}, importId=${task.id}, videoId=${createdVideo.id}`);
    } catch (error : unknown) {
      await this.cleanupYoutubeDownloadedFiles(storagePrefix);

      if (task.cancelRequested === true) {
        this.updateYoutubeImportTask(task, {
          status: 'cancelled',
          stageMessage: 'YouTube letöltés megszakítva.',
          errorMessage: '',
        });
        this.logger.warn(`YouTube import megszakítva. ownerId=${task.ownerId}, importId=${task.id}`);
        return;
      }

      const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      const userFriendlyMessage : string = this.formatYoutubeImportError(details, task);
      this.updateYoutubeImportTask(task, {
        status: 'failed',
        stageMessage: 'YouTube letöltés hibával leállt.',
        errorMessage: userFriendlyMessage,
      });
      this.logger.error(`YouTube import hiba. ownerId=${task.ownerId}, importId=${task.id}, details=${details}`);
    }
  }

  private async runYtDlpDownload(task : YoutubeImportTask, command : string, outputTemplate : string) : Promise<void> {
    const args : string[] = [
      '--no-playlist',
      '--newline',
      '--restrict-filenames',
      '--merge-output-format',
      'mp4',
      '-o',
      outputTemplate,
      task.url,
    ];

    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      const child : ChildProcess = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      task.downloadProcess = child;

      let combinedErrorOutput : string = '';

      const onOutput = (chunk : Buffer) : void => {
        const text : string = chunk.toString('utf8');
        combinedErrorOutput += text;
        const lines : string[] = text.split(/\r?\n/);
        for (const line of lines) {
          this.tryUpdateYoutubeTaskTitleFromOutputLine(task, line, `${task.id}-`);
          const progressPercent : number | null = this.extractYoutubeDownloadProgressPercent(line);
          if (progressPercent !== null) {
            const mappedPercent : number = Math.min(95, Math.max(1, Math.round(progressPercent)));
            if (mappedPercent > task.progressPercent) {
              this.updateYoutubeImportTask(task, {
                progressPercent: mappedPercent,
                stageMessage: 'YouTube letöltés folyamatban...',
              });
            }
          }
          if (line.includes('[Merger]') === true) {
            this.updateYoutubeImportTask(task, {
              progressPercent: Math.max(task.progressPercent, 95),
              stageMessage: 'YouTube letöltés utófeldolgozás...',
            });
          }
        }
      };

      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);

      child.on('error', (error : Error) => {
        task.downloadProcess = null;
        reject(error);
      });

      child.on('close', (code : number | null, signal : NodeJS.Signals | null) => {
        task.downloadProcess = null;
        if (task.cancelRequested === true) {
          reject(new Error('YouTube letöltés megszakítva.'));
          return;
        }
        if (code !== 0) {
          const tail : string = combinedErrorOutput.slice(-1200).trim();
          reject(
            new Error(
              `yt-dlp hiba (exit=${code ?? 'n/a'}, signal=${signal ?? 'none'}). ${tail.length > 0 ? tail : 'Nincs részletes hibaüzenet.'}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  private extractYoutubeDownloadProgressPercent(line : string) : number | null {
    const match : RegExpMatchArray | null = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
    if (match === null) {
      return null;
    }
    const parsed : number = Number(match[1]);
    if (Number.isFinite(parsed) === false) {
      return null;
    }
    return Math.max(0, Math.min(100, parsed));
  }

  private async findYoutubeDownloadedStorageFileName(prefix : string) : Promise<string> {
    const entries : string[] = await readdir(this.uploadsDir);
    const files : string[] = entries.filter((name : string) => {
      const normalized : string = name.trim().toLowerCase();
      if (normalized.startsWith(prefix.toLowerCase()) === false) {
        return false;
      }
      if (normalized.endsWith('.part') || normalized.endsWith('.ytdl') || normalized.endsWith('.tmp')) {
        return false;
      }
      return true;
    });

    if (files.length === 0) {
      throw new BadRequestException('A letöltött YouTube fájl nem található.');
    }
    if (files.length === 1) {
      return files[0];
    }

    const withMtime : Array<{ fileName : string; mtimeMs : number }> = await Promise.all(
      files.map(async (fileName : string) => {
        const fullPath : string = join(this.uploadsDir, fileName);
        const fileStat = await stat(fullPath);
        return {
          fileName,
          mtimeMs: fileStat.mtimeMs,
        };
      }),
    );
    withMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return withMtime[0].fileName;
  }

  private deriveOriginalFileNameFromYoutubeDownload(storageFileName : string, prefix : string) : string {
    const extension : string = extname(storageFileName);
    const base : string = basename(storageFileName, extension);
    let titlePart : string = base;
    if (titlePart.startsWith(prefix) === true) {
      titlePart = titlePart.slice(prefix.length);
    }
    const normalizedTitlePart : string = titlePart.trim().length > 0 ? titlePart.trim() : `youtube-${Date.now()}`;
    return `${normalizedTitlePart}${extension}`;
  }

  private deriveYoutubeFallbackTitle(url : string) : string {
    try {
      const parsed : URL = new URL(url);
      const videoId : string = parsed.searchParams.get('v')?.trim() ?? '';
      if (videoId.length > 0) {
        return `YouTube: ${videoId}`;
      }
      const pathSegment : string = parsed.pathname.split('/').filter((segment : string) => segment.length > 0).pop() ?? '';
      if (pathSegment.length > 0) {
        return `YouTube: ${pathSegment}`;
      }
    } catch {
      // Fallback title marad.
    }
    return 'YouTube videó';
  }

  private tryUpdateYoutubeTaskTitleFromOutputLine(task : YoutubeImportTask, line : string, prefix : string) : void {
    const trimmedLine : string = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const destinationMatch : RegExpMatchArray | null = trimmedLine.match(/Destination:\s+(.+)$/i);
    if (destinationMatch !== null) {
      this.setYoutubeTaskTitleFromOutputPath(task, destinationMatch[1], prefix);
      return;
    }

    const mergeMatch : RegExpMatchArray | null = trimmedLine.match(/Merging formats into\s+"(.+)"/i);
    if (mergeMatch !== null) {
      this.setYoutubeTaskTitleFromOutputPath(task, mergeMatch[1], prefix);
    }
  }

  private setYoutubeTaskTitleFromOutputPath(task : YoutubeImportTask, outputPath : string, prefix : string) : void {
    const rawPath : string = outputPath.trim().replace(/^"+|"+$/g, '');
    if (rawPath.length === 0) {
      return;
    }

    const fileName : string = basename(rawPath);
    const extension : string = extname(fileName);
    let baseName : string = basename(fileName, extension);

    if (baseName.startsWith(prefix) === true) {
      baseName = baseName.slice(prefix.length);
    }
    baseName = baseName.replace(/\.f\d+$/i, '').trim();
    if (baseName.length === 0) {
      return;
    }

    const humanTitle : string = baseName.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (humanTitle.length === 0 || humanTitle === task.displayTitle) {
      return;
    }

    this.updateYoutubeImportTask(task, {
      displayTitle: humanTitle,
    });
  }

  private async cleanupYoutubeDownloadedFiles(prefix : string) : Promise<void> {
    const entries : string[] = await readdir(this.uploadsDir);
    const matches : string[] = entries.filter((entry : string) => entry.startsWith(prefix));
    await Promise.all(
      matches.map(async (fileName : string) => {
        await rm(join(this.uploadsDir, fileName), { force: true });
      }),
    );
  }

  private assertYoutubeImportNotCancelled(task : YoutubeImportTask) : void {
    if (task.cancelRequested === true) {
      throw new Error('YouTube letöltés megszakítva.');
    }
  }

  private async resolveYtDlpCommand() : Promise<string> {
    const fromConfig : string | undefined = this.configService.get<string>('YTDLP_COMMAND');
    const fromEnv : string | undefined = process.env.YTDLP_COMMAND;
    const command : string = (fromConfig ?? fromEnv ?? 'yt-dlp').trim();
    if (command.length > 0 && command !== 'yt-dlp') {
      return command;
    }

    const whisperCommandFromConfig : string | undefined = this.configService.get<string>('WHISPER_COMMAND');
    const whisperCommandFromEnv : string | undefined = process.env.WHISPER_COMMAND;
    const whisperCommand : string = (whisperCommandFromConfig ?? whisperCommandFromEnv ?? '').trim();
    if (whisperCommand.length > 0) {
      const siblingYtDlp : string = join(dirname(whisperCommand), 'yt-dlp');
      try {
        await access(siblingYtDlp);
        return siblingYtDlp;
      } catch {
        // Fallback a PATH-beli parancsra.
      }
    }

    return 'yt-dlp';
  }

  private formatYoutubeImportError(details : string, task : YoutubeImportTask) : string {
    const normalized : string = details.toLowerCase();
    const hasYoutubeSignatureIssue : boolean =
      normalized.includes('precondition check failed') ||
      normalized.includes('http error 403') ||
      normalized.includes('nsig extraction failed');

    if (hasYoutubeSignatureIssue === true) {
      return [
        'A YouTube letöltés sikertelen (YouTube 400/403 válasz).',
        'Valószínűleg elavult yt-dlp verzió fut.',
        'Javaslat: frissítsd a whisper venv-ben a yt-dlp-t és állítsd be a YTDLP_COMMAND változót erre:',
        '/home/winben/whisper/.venv/bin/yt-dlp',
        `Részletek: ${details}`,
      ].join(' ');
    }

    return details;
  }

  private normalizeYoutubeUrl(rawUrl : string) : string {
    const trimmed : string = rawUrl.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('A YouTube URL megadása kötelező.');
    }

    let parsed : URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('Érvénytelen YouTube URL.');
    }

    const protocol : string = parsed.protocol.trim().toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new BadRequestException('A YouTube URL csak http vagy https lehet.');
    }

    const hostname : string = parsed.hostname.trim().toLowerCase();
    const isYoutubeHost : boolean =
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtu.be' ||
      hostname.endsWith('.youtu.be');

    if (isYoutubeHost === false) {
      throw new BadRequestException('Csak YouTube URL adható meg.');
    }

    return parsed.toString();
  }

  private requireOwnedYoutubeImportTask(ownerId : number, importId : string) : YoutubeImportTask {
    const task : YoutubeImportTask | undefined = this.youtubeImportTasks.get(importId);
    if (task === undefined || task.ownerId !== ownerId) {
      throw new NotFoundException('A YouTube import folyamat nem található.');
    }
    return task;
  }

  private updateYoutubeImportTask(task : YoutubeImportTask, patch : Partial<YoutubeImportTask>) : void {
    Object.assign(task, patch);
    task.updatedAt = new Date();
    this.youtubeImportTasks.set(task.id, task);
  }

  private toYoutubeImportStartResponse(task : YoutubeImportTask) : YoutubeImportStartResponse {
    return {
      importId: task.id,
      displayTitle: task.displayTitle,
      status: task.status,
      progressPercent: task.progressPercent,
      stageMessage: task.stageMessage,
    };
  }

  private toYoutubeImportStatusResponse(task : YoutubeImportTask) : YoutubeImportStatusResponse {
    return {
      id: task.id,
      displayTitle: task.displayTitle,
      status: task.status,
      progressPercent: task.progressPercent,
      stageMessage: task.stageMessage,
      errorMessage: task.errorMessage,
      videoId: task.videoId,
      updatedAt: task.updatedAt,
    };
  }

  private pruneYoutubeImportTasks() : void {
    const retentionMs : number = 24 * 60 * 60 * 1000;
    const nowMs : number = Date.now();
    for (const [taskId, task] of this.youtubeImportTasks.entries()) {
      const isTerminal : boolean = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
      if (isTerminal === false) {
        continue;
      }
      if (nowMs - task.updatedAt.getTime() > retentionMs) {
        this.youtubeImportTasks.delete(taskId);
      }
    }
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
      processingStatus: this.normalizeProcessingStatus(video.processingStatus),
      thumbnailUrl: video.thumbnailFileName.length > 0 ? `/api/uploads/${video.thumbnailFileName}` : '',
    };
  }

  /**
   * Részletes videó DTO.
   * @param video Videó entitás.
   * @returns Részletes objektum.
   */
  private async toVideoDetails(video : VideoEntity) : Promise<VideoDetails> {
    const whisperSettings : { language : string; wordsPerLine : number } = await this.readUserWhisperSettings(video.ownerId);
    return {
      ...this.toVideoListItem(video),
      subtitleText: video.subtitleText,
      listenRequested: video.listenRequested,
      mediaUrl: `/api/uploads/${video.storageFileName}`,
      subtitlePresetId: video.subtitlePresetId ?? null,
      socialTextCombined: video.socialTextCombined ?? '',
      whisperModel: this.whisperModel,
      whisperLanguage: whisperSettings.language,
      wordsPerLine: whisperSettings.wordsPerLine,
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
   * Csak video/audio fájlok engedélyezése kiterjesztés és MIME alapján.
   * @param fileName Eredeti fájlnév.
   * @param mimeType Opcionális MIME típus.
   */
  private assertAllowedMediaFile(fileName : string, mimeType ?: string) : void {
    const extensionAllowed : boolean = isAllowedMediaExtension(fileName);
    const mimeAllowed : boolean = isAllowedMediaMimeType(mimeType);

    // Chunk initnél a MIME lehet üres, ezért ott kiterjesztés is elég.
    // Direkt uploadnál mindkettő elérhető; itt akkor engedünk, ha bármelyik egyértelműen média.
    if (extensionAllowed === false && mimeAllowed === false) {
      throw new BadRequestException('Csak videó és hangfájl tölthető fel.');
    }
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
   * Szükség esetén H.264/AAC MP4 formátumba konvertálja a feltöltött videót.
   * Ha a fájl már megfelelő, változtatás nélkül marad.
   * @param storageFileName Feltöltött fájl szerver oldali neve.
   * @returns A véglegesen tárolt fájl neve és mérete.
   */
  private async normalizeUploadedMediaFile(storageFileName : string) : Promise<StoredMediaFile> {
    const inputPath : string = join(this.uploadsDir, storageFileName);
    const probed : ProbedMediaFile | null = await this.probeMediaFile(inputPath);
    const inputFileStat = await stat(inputPath);

    if (this.shouldConvertToTargetFormat(probed) === false) {
      this.logger.log(
        `Konvertálás kihagyva (már kompatibilis). file="${storageFileName}", codec="${probed?.videoStream?.codecName ?? 'unknown'}", audio="${
          probed?.audioStream?.codecName ?? 'none'
        }"`,
      );
      return {
        storageFileName,
        fileSizeBytes: Number(inputFileStat.size),
      };
    }

    this.logger.log(
      `Konvertálás szükséges. input="${storageFileName}", format="${probed?.formatNames.join(',') ?? 'unknown'}", videoCodec="${
        probed?.videoStream?.codecName ?? 'unknown'
      }", audioCodec="${probed?.audioStream?.codecName ?? 'unknown'}"`,
    );

    let convertedStorageFileName : string = this.generateStorageFileName('.mp4');
    while (convertedStorageFileName === storageFileName) {
      convertedStorageFileName = this.generateStorageFileName('.mp4');
    }
    const outputPath : string = join(this.uploadsDir, convertedStorageFileName);

    try {
      await this.convertVideoToH264AacMp4({
        inputPath,
        outputPath,
        videoBitRate: probed?.videoStream?.bitRate ?? probed?.formatBitRate ?? null,
        audioBitRate: probed?.audioStream?.bitRate ?? null,
      });
    } catch (error : unknown) {
      await rm(outputPath, { force: true });
      throw error;
    }

    await rm(inputPath, { force: true });
    const convertedStat = await stat(outputPath);
    this.logger.log(
      `Konvertálás kész. input="${storageFileName}" -> output="${convertedStorageFileName}", outSize=${Number(convertedStat.size)}`,
    );
    return {
      storageFileName: convertedStorageFileName,
      fileSizeBytes: Number(convertedStat.size),
    };
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
    const thumbnailFileName : string = await this.generateThumbnailForVideo(storageFileName, durationSeconds);
    const createdVideo : VideoEntity = this.videosRepository.create({
      ownerId,
      originalFileName,
      storageFileName,
      thumbnailFileName,
      fileSizeBytes,
      durationSeconds,
      isHidden: false,
      listenRequested: false,
      subtitleText: '',
      processingStatus: 'idle',
      socialTextCombined: '',
      subtitlePresetId: null,
    });

    let savedVideo : VideoEntity;
    try {
      savedVideo = await this.videosRepository.save(createdVideo);
    } catch (error : unknown) {
      if (thumbnailFileName.length > 0) {
        await rm(join(this.uploadsDir, thumbnailFileName), { force: true });
      }
      throw error;
    }
    this.logger.log(
      `Videó rekord létrehozva. ownerId=${ownerId}, videoId=${savedVideo.id}, original="${originalFileName}", stored="${storageFileName}", thumbnail="${
        thumbnailFileName.length > 0 ? thumbnailFileName : 'none'
      }", size=${fileSizeBytes}, durationSec=${durationSeconds}`,
    );
    return await this.toVideoDetails(savedVideo);
  }

  /**
   * Thumbnail képet készít a videó 2. másodpercéből.
   * Rövid videónál biztonságos fallback időpontra ugrik.
   * @param storageFileName Tárolt videófájl neve.
   * @param durationSeconds Videó hossza másodpercben.
   * @returns Relatív thumbnail fájlnév vagy üres string, ha nem sikerült.
   */
  private async generateThumbnailForVideo(storageFileName : string, durationSeconds : number) : Promise<string> {
    const sourcePath : string = join(this.uploadsDir, storageFileName);
    const thumbnailsDir : string = join(this.uploadsDir, 'thumbnails');
    await mkdir(thumbnailsDir, { recursive: true });

    const seekSeconds : number = durationSeconds >= 2 ? 2 : Math.max(0.2, durationSeconds / 2);
    const outputFileName : string = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}.jpg`;
    const relativePath : string = `thumbnails/${outputFileName}`;
    const outputPath : string = join(this.uploadsDir, relativePath);

    try {
      await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
        execFile(
          'ffmpeg',
          [
            '-y',
            '-ss',
            String(seekSeconds),
            '-i',
            sourcePath,
            '-frames:v',
            '1',
            '-q:v',
            '3',
            outputPath,
          ],
          { timeout: 0 },
          (error : Error | null, stdout : string, stderr : string) => {
            if (error !== null) {
              reject(new Error(`${stdout}\n${stderr}`.trim()));
              return;
            }
            resolve();
          },
        );
      });
      this.logger.log(`Thumbnail elkészült. source="${storageFileName}", seekSec=${seekSeconds.toFixed(2)}, file="${relativePath}"`);
      return relativePath;
    } catch (error : unknown) {
      const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.warn(`Thumbnail készítés sikertelen. source="${storageFileName}", details=${details}`);
      await rm(outputPath, { force: true });
      return '';
    }
  }

  /**
   * User whisper beállítások kiolvasása default fallbackkel.
   * @param ownerId User azonosító.
   * @returns Normalizált whisper nyelv és szószám.
   */
  private async readUserWhisperSettings(ownerId : number) : Promise<{ language : string; wordsPerLine : number }> {
    const owner : UserEntity | null = await this.usersRepository.findOne({ where: { id: ownerId } });
    if (owner === null) {
      return {
        language: this.defaultWhisperLanguage,
        wordsPerLine: this.defaultWordsPerLine,
      };
    }

    const normalizedLanguage : string = owner.whisperLanguage.trim();
    const safeLanguage : string = normalizedLanguage.length > 0 ? normalizedLanguage : this.defaultWhisperLanguage;
    const safeWordsPerLine : number = Math.min(30, Math.max(1, Math.round(owner.wordsPerLine)));
    return {
      language: safeLanguage,
      wordsPerLine: safeWordsPerLine,
    };
  }

  /**
   * User whisper beállítások mentése.
   * @param ownerId User azonosító.
   * @param language Nyelv kód.
   * @param wordsPerLine Szó/sor.
   * @returns Nem ad vissza értéket.
   */
  private async saveUserWhisperSettings(ownerId : number, language : string, wordsPerLine : number) : Promise<void> {
    const owner : UserEntity | null = await this.usersRepository.findOne({ where: { id: ownerId } });
    if (owner === null) {
      return;
    }

    const normalizedLanguage : string = language.trim();
    owner.whisperLanguage = normalizedLanguage.length > 0 ? normalizedLanguage : this.defaultWhisperLanguage;
    owner.wordsPerLine = Math.min(30, Math.max(1, Math.round(wordsPerLine)));
    await this.usersRepository.save(owner);
  }

  /**
   * Eldönti, hogy szükséges-e átkódolás H.264/AAC MP4 formátumba.
   * Csak videó streamet tartalmazó média esetén konvertál.
   * @param probed ffprobe adatok.
   * @returns Igaz, ha konvertálni kell.
   */
  private shouldConvertToTargetFormat(probed : ProbedMediaFile | null) : boolean {
    if (probed === null) {
      return true;
    }
    if (probed.videoStream === null || probed.videoStream.codecName === null) {
      return false;
    }

    const isMp4Container : boolean = probed.formatNames.includes('mp4');
    const isH264Video : boolean = probed.videoStream.codecName === 'h264';
    const isAacAudio : boolean =
      probed.audioStream === null ||
      probed.audioStream.codecName === null ||
      probed.audioStream.codecName === 'aac';

    return !(isMp4Container && isH264Video && isAacAudio);
  }

  /**
   * ffprobe JSON alapján kiolvassa a konténer/codec/bitráta adatokat.
   * @param inputPath Elemzendő média fájl útvonala.
   * @returns Feldolgozott média metaadat vagy null.
   */
  private async probeMediaFile(inputPath : string) : Promise<ProbedMediaFile | null> {
    return await new Promise<ProbedMediaFile | null>((resolve : (value : ProbedMediaFile | null) => void) => {
      execFile(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputPath,
        ],
        { timeout: 20_000 },
        (error : Error | null, stdout : string) => {
          if (error !== null || stdout.trim().length === 0) {
            resolve(null);
            return;
          }

          let parsed : unknown;
          try {
            parsed = JSON.parse(stdout) as unknown;
          } catch {
            resolve(null);
            return;
          }

          const rawObject : Record<string, unknown> | null = this.asObject(parsed);
          if (rawObject === null) {
            resolve(null);
            return;
          }

          const rawFormat : Record<string, unknown> | null = this.asObject(rawObject['format']);
          const formatNames : string[] = this.parseFormatNames(rawFormat?.['format_name']);
          const formatBitRate : number | null = this.parseBitRate(rawFormat?.['bit_rate']);

          const rawStreamsValue : unknown = rawObject['streams'];
          const rawStreams : unknown[] = Array.isArray(rawStreamsValue) ? rawStreamsValue : [];
          const streamObjects : Record<string, unknown>[] = rawStreams
            .map((stream : unknown) : Record<string, unknown> | null => this.asObject(stream))
            .filter((stream : Record<string, unknown> | null) : stream is Record<string, unknown> => stream !== null);

          const videoRaw : Record<string, unknown> | undefined = streamObjects.find(
            (stream : Record<string, unknown>) => this.parseCodecType(stream['codec_type']) === 'video',
          );
          const audioRaw : Record<string, unknown> | undefined = streamObjects.find(
            (stream : Record<string, unknown>) => this.parseCodecType(stream['codec_type']) === 'audio',
          );

          resolve({
            formatNames,
            formatBitRate,
            videoStream: this.toProbedStream(videoRaw),
            audioStream: this.toProbedStream(audioRaw),
          });
        },
      );
    });
  }

  /**
   * ffmpeg alapú átkódolás H.264/AAC MP4 célformátumba.
   * @param params Konverziós paraméterek.
   * @returns Nem ad vissza értéket.
   */
  private async convertVideoToH264AacMp4(params : {
    inputPath : string;
    outputPath : string;
    videoBitRate : number | null;
    audioBitRate : number | null;
  }) : Promise<void> {
    const targetVideoBitRate : number | null = this.scaleBitRate(params.videoBitRate, this.uploadVideoBitRateMultiplier);
    const targetAudioBitRate : number | null = this.scaleBitRate(params.audioBitRate, this.uploadAudioBitRateMultiplier);
    const startedAt : number = Date.now();
    this.logger.log(
      `FFmpeg konvertálás indult. input="${params.inputPath}", output="${params.outputPath}", videoBitrate=${
        params.videoBitRate ?? 'auto'
      } -> ${targetVideoBitRate ?? 'auto'}, audioBitrate=${params.audioBitRate ?? 'auto'} -> ${targetAudioBitRate ?? 'auto'}, preset=${
        this.uploadTranscodePreset
      }`,
    );
    const ffmpegArgs : string[] = [
      '-y',
      '-i',
      params.inputPath,
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      this.uploadTranscodePreset,
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
    ];

    if (targetVideoBitRate !== null) {
      ffmpegArgs.push('-b:v', this.toBitRateArgument(targetVideoBitRate, 100));
    }
    if (targetAudioBitRate !== null) {
      ffmpegArgs.push('-b:a', this.toBitRateArgument(targetAudioBitRate, 32));
    }

    ffmpegArgs.push(params.outputPath);

    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      execFile(
        'ffmpeg',
        ffmpegArgs,
        { timeout: 0 },
        (error : Error | null, stdout : string, stderr : string) => {
          if (error !== null) {
            const details : string = `${stdout}\n${stderr}`.trim();
            this.logger.error(`FFmpeg konvertálás hiba. output="${params.outputPath}", details=${details}`);
            reject(new BadRequestException(`A videó konvertálása sikertelen: ${details}`));
            return;
          }
          this.logger.log(`FFmpeg konvertálás kész. output="${params.outputPath}", elapsedMs=${Date.now() - startedAt}`);
          resolve();
        },
      );
    });
  }

  /**
   * Becsült bitráta átalakítása ffmpeg argumentummá.
   * @param bitRate Bitráta bit/s értékben.
   * @param minimumKbps Minimális kbit/s érték.
   * @returns ffmpeg kompatibilis bitráta (`1234k`).
   */
  private toBitRateArgument(bitRate : number, minimumKbps : number) : string {
    const kbps : number = Math.max(minimumKbps, Math.round(bitRate / 1000));
    return `${kbps}k`;
  }

  /**
   * Bitráta szorzása minőség-kompenzációhoz gyorsabb preset mellett.
   * @param bitRate Kiinduló bitráta bit/s értékben.
   * @param multiplier Szorzó.
   * @returns Szorzott bitráta bit/s értékben vagy null.
   */
  private scaleBitRate(bitRate : number | null, multiplier : number) : number | null {
    if (bitRate === null) {
      return null;
    }
    const scaled : number = Math.round(bitRate * multiplier);
    if (Number.isFinite(scaled) === false || scaled <= 0) {
      return null;
    }
    return scaled;
  }

  /**
   * Egységes, véletlen szerver oldali fájlnév generálás.
   * @param extension Fájlkiterjesztés ponttal együtt.
   * @returns Generált fájlnév.
   */
  private generateStorageFileName(extension : string) : string {
    return `${Date.now()}-${Math.round(Math.random() * 1_000_000)}${extension}`;
  }

  /**
   * Ismeretlen bemenet objektummá konvertálása.
   * @param value Nyers bemenet.
   * @returns Objektum vagy null.
   */
  private asObject(value : unknown) : Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  /**
   * formátumnevek normalizálása ffprobe válaszból.
   * @param rawFormatName Nyers formátumnév mező.
   * @returns Normalizált formátumnév lista.
   */
  private parseFormatNames(rawFormatName : unknown) : string[] {
    if (typeof rawFormatName !== 'string') {
      return [];
    }
    return rawFormatName
      .split(',')
      .map((formatName : string) => formatName.trim().toLowerCase())
      .filter((formatName : string) => formatName.length > 0);
  }

  /**
   * Nyers codec típus normalizálása.
   * @param rawCodecType Nyers codec_type érték.
   * @returns `video`, `audio` vagy null.
   */
  private parseCodecType(rawCodecType : unknown) : string | null {
    if (typeof rawCodecType !== 'string') {
      return null;
    }
    const normalized : string = rawCodecType.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    return normalized;
  }

  /**
   * Stream objektumból codec + bitráta kiolvasása.
   * @param stream Nyers stream objektum.
   * @returns Egységes stream információ vagy null.
   */
  private toProbedStream(stream ?: Record<string, unknown>) : ProbedMediaStream | null {
    if (stream === undefined) {
      return null;
    }
    const codecName : string | null = this.parseCodecName(stream['codec_name']);
    const bitRate : number | null = this.parseBitRate(stream['bit_rate']);
    return {
      codecName,
      bitRate,
    };
  }

  /**
   * Nyers codec név normalizálása.
   * @param rawCodecName Nyers codec név.
   * @returns Codec név vagy null.
   */
  private parseCodecName(rawCodecName : unknown) : string | null {
    if (typeof rawCodecName !== 'string') {
      return null;
    }
    const normalized : string = rawCodecName.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  /**
   * Nyers bitráta mező számmá alakítása.
   * @param rawBitRate Nyers bitráta.
   * @returns Bit/s vagy null.
   */
  private parseBitRate(rawBitRate : unknown) : number | null {
    const parsed : number = Number(rawBitRate);
    if (Number.isFinite(parsed) === false) {
      return null;
    }
    const rounded : number = Math.round(parsed);
    if (rounded <= 0) {
      return null;
    }
    return rounded;
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
   * Feldolgozási státusz normalizálása API szerződés szerint.
   * @param processingStatus Nyers státusz adatbázisból.
   * @returns `idle`, `queued` vagy `pending`.
   */
  private normalizeProcessingStatus(processingStatus : string) : string {
    const normalized : string = processingStatus.trim().toLowerCase();
    if (normalized === 'pending' || normalized === 'processing') {
      return 'pending';
    }
    if (normalized === 'queued') {
      return 'queued';
    }
    return 'idle';
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
