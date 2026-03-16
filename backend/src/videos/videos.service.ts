import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, rm, stat, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { execFile } from 'child_process';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import { VideoEntity } from './entities/video.entity';
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
}

export interface VideoDetails extends VideoListItem {
  subtitleText : string;
  listenRequested : boolean;
  mediaUrl : string;
  subtitlePresetId : number | null;
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

export interface InitUploadResponse {
  uploadId : string;
  chunkSizeBytes : number;
  totalChunks : number;
}

export interface ExportedVideoFile {
  filePath : string;
  fileName : string;
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
    @InjectRepository(SubtitlePresetEntity)
    private readonly presetsRepository : Repository<SubtitlePresetEntity>,
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
   * Whisper beállítások mentése az adott videóhoz.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param dto Mentendő whisper beállítások.
   * @returns Módosított videó.
   */
  public async updateWhisperSettings(ownerId : number, videoId : number, dto : WhisperSettingsDto) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    video.whisperModel = dto.model;
    video.whisperLanguage = dto.language;
    video.wordsPerLine = dto.wordsPerLine;
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * Lehallgatási igény jelölése és a whisper beállítások mentése.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @param dto Lehallgatási beállítások.
   * @returns Módosított videó.
   */
  public async requestListenWithSettings(ownerId : number, videoId : number, dto : WhisperSettingsDto) : Promise<VideoDetails> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    video.whisperModel = dto.model;
    video.whisperLanguage = dto.language;
    video.wordsPerLine = dto.wordsPerLine;
    video.listenRequested = true;
    video.processingStatus = 'queued';
    const savedVideo : VideoEntity = await this.videosRepository.save(video);
    return this.toVideoDetails(savedVideo);
  }

  /**
   * SRT videóra égetése ASS stílussal.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Elkészült videófájl elérési adatai.
   */
  public async exportBurnedVideo(ownerId : number, videoId : number) : Promise<ExportedVideoFile> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    const subtitleText : string = video.subtitleText.trim();
    if (subtitleText.length === 0) {
      throw new BadRequestException('Nincs mentett felirat, nem exportálható videó.');
    }
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

    const inputPath : string = join(this.uploadsDir, video.storageFileName);
    const exportDir : string = join(process.cwd(), 'data', 'exports', String(ownerId));
    await mkdir(exportDir, { recursive: true });

    const safeBaseName : string = basename(video.originalFileName, extname(video.originalFileName))
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const stamp : string = String(Date.now());
    const assPath : string = join(exportDir, `${safeBaseName}-${video.id}-${stamp}.ass`);
    const outputPath : string = join(exportDir, `${safeBaseName}-${video.id}-${stamp}.mp4`);
    const outputFileName : string = `${safeBaseName}-subtitled.mp4`;

    const assContent : string = this.buildAssFileContent(video, preset);
    await writeFile(assPath, assContent, 'utf8');
    await this.runFfmpegBurn(inputPath, assPath, outputPath);

    return {
      filePath: outputPath,
      fileName: outputFileName,
    };
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
      subtitlePresetId: video.subtitlePresetId ?? null,
      whisperModel: video.whisperModel,
      whisperLanguage: video.whisperLanguage,
      wordsPerLine: video.wordsPerLine,
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
      whisperModel: 'medium',
      whisperLanguage: 'hu',
      wordsPerLine: 7,
      processingStatus: 'idle',
      subtitlePresetId: null,
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
   * ASS fájl tartalom építése az SRT és sablon adatok alapján.
   * @param video Videó entitás.
   * @param preset Sablon entitás.
   * @returns ASS fájl teljes tartalma.
   */
  private buildAssFileContent(video : VideoEntity, preset : SubtitlePresetEntity) : string {
    const bold : number = preset.bold ? 1 : 0;
    const italic : number = preset.italic ? 1 : 0;
    const underline : number = preset.underline ? 1 : 0;
    const strikeOut : number = preset.strikeOut ? 1 : 0;

    const assLines : string[] = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'Collisions: Normal',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      `Style: Default,${preset.fontName},${preset.fontSize},${this.hexToAegisubColor(preset.primaryColour)},${this.hexToAegisubColor(preset.secondaryColour)},${this.hexToAegisubColor(preset.outlineColour)},&H80000000,${bold},${italic},${underline},${strikeOut},${preset.scaleX},${preset.scaleY},${preset.spacing},${preset.angle},${preset.borderStyle},${preset.outline},${preset.shadow},${preset.alignment},${preset.marginL},${preset.marginR},${preset.marginV},${preset.encoding}`,
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ];

    const subtitleEvents : Array<{ start : string; end : string; text : string }> = this.parseSrtEvents(video.subtitleText);
    if (subtitleEvents.length === 0) {
      const endSeconds : number = Math.max(1, video.durationSeconds);
      const plainText : string = this.escapeAssText(video.subtitleText).replace(/\n/g, '\\N');
      assLines.push(`Dialogue: 0,0:00:00.00,${this.secondsToAssTime(endSeconds)},Default,,0,0,0,,${plainText}`);
      return `${assLines.join('\n')}\n`;
    }

    for (const event of subtitleEvents) {
      assLines.push(`Dialogue: 0,${event.start},${event.end},Default,,0,0,0,,${event.text}`);
    }

    return `${assLines.join('\n')}\n`;
  }

  /**
   * SRT szöveg ASS eseményekké alakítása.
   * @param subtitleText SRT tartalom.
   * @returns ASS esemény lista.
   */
  private parseSrtEvents(subtitleText : string) : Array<{ start : string; end : string; text : string }> {
    const normalized : string = subtitleText.replace(/\r\n/g, '\n');
    const blocks : string[] = normalized.split(/\n{2,}/).map((block : string) => block.trim()).filter((block : string) => block.length > 0);
    const events : Array<{ start : string; end : string; text : string }> = [];

    for (const block of blocks) {
      const lines : string[] = block.split('\n');
      if (lines.length < 2) {
        continue;
      }

      const timeLineIndex : number = lines[0].includes('-->') ? 0 : 1;
      const timeLine : string = lines[timeLineIndex] ?? '';
      const timeMatch : RegExpMatchArray | null = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
      );
      if (timeMatch === null) {
        continue;
      }

      const textLines : string[] = lines.slice(timeLineIndex + 1);
      const rawText : string = textLines.join('\n').trim();
      if (rawText.length === 0) {
        continue;
      }

      events.push({
        start: this.srtTimeToAssTime(timeMatch[1]),
        end: this.srtTimeToAssTime(timeMatch[2]),
        text: this.escapeAssText(rawText).replace(/\n/g, '\\N'),
      });
    }

    return events;
  }

  /**
   * SRT időbélyeg ASS formátumra konvertálása.
   * @param value SRT időpont.
   * @returns ASS időpont.
   */
  private srtTimeToAssTime(value : string) : string {
    const normalized : string = value.replace(',', '.');
    const match : RegExpMatchArray | null = normalized.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})/);
    if (match === null) {
      return '0:00:00.00';
    }

    const hours : number = Number(match[1]);
    const minutes : number = Number(match[2]);
    const seconds : number = Number(match[3]);
    const milliseconds : number = Number(match[4].padEnd(3, '0'));
    const totalMilliseconds : number = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds;
    return this.millisecondsToAssTime(totalMilliseconds);
  }

  /**
   * Másodperc ASS időformátumra.
   * @param seconds Egész másodperc.
   * @returns ASS időpont.
   */
  private secondsToAssTime(seconds : number) : string {
    const totalMilliseconds : number = Math.max(0, Math.round(seconds * 1_000));
    return this.millisecondsToAssTime(totalMilliseconds);
  }

  /**
   * Milliszekundum ASS időformátumra.
   * @param totalMilliseconds Idő ms-ban.
   * @returns ASS időpont.
   */
  private millisecondsToAssTime(totalMilliseconds : number) : string {
    const safeMs : number = Math.max(0, totalMilliseconds);
    const hours : number = Math.floor(safeMs / 3_600_000);
    const minutes : number = Math.floor((safeMs % 3_600_000) / 60_000);
    const seconds : number = Math.floor((safeMs % 60_000) / 1_000);
    const centiseconds : number = Math.floor((safeMs % 1_000) / 10);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  }

  /**
   * HTML hex szín ASS/Aegisub színformátumra konvertálása.
   * @param hexColor `#RRGGBB` forma.
   * @returns `&H00BBGGRR` forma.
   */
  private hexToAegisubColor(hexColor : string) : string {
    const match : RegExpMatchArray | null = hexColor.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (match === null) {
      return '&H00FFFFFF';
    }
    const rgb : string = match[1].toUpperCase();
    const rr : string = rgb.slice(0, 2);
    const gg : string = rgb.slice(2, 4);
    const bb : string = rgb.slice(4, 6);
    return `&H00${bb}${gg}${rr}`;
  }

  /**
   * ASS szöveg escape.
   * @param text Nyers feliratszöveg.
   * @returns Biztonságos ASS szöveg.
   */
  private escapeAssText(text : string) : string {
    return text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
  }

  /**
   * ffmpeg futtatása az ASS beégetéshez.
   * @param inputPath Bemeneti videó.
   * @param assPath ASS fájl.
   * @param outputPath Kimeneti videó.
   * @returns Nem ad vissza értéket.
   */
  private async runFfmpegBurn(inputPath : string, assPath : string, outputPath : string) : Promise<void> {
    const subtitleFilter : string = `ass=${assPath.replace(/\\/g, '/')}`;
    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      execFile(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vf',
          subtitleFilter,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outputPath,
        ],
        { timeout: 0 },
        (error : Error | null, stdout : string, stderr : string) => {
          if (error !== null) {
            const details : string = `${stdout}\n${stderr}`.trim();
            reject(new Error(`A videó exportálása sikertelen: ${details}`));
            return;
          }
          resolve();
        },
      );
    });
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
