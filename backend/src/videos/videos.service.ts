import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, rm, stat, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { execFile } from 'child_process';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import {
  TOKEN_COST_EXPORT,
  TOKEN_COST_LISTEN_PER_MINUTE,
  TOKEN_COST_SOCIAL_TEXT,
  TOKEN_COST_UPLOAD,
  TOKEN_ENTRY_TYPE_EXPORT,
  TOKEN_ENTRY_TYPE_LISTEN,
  TOKEN_ENTRY_TYPE_SOCIAL_TEXT,
  TOKEN_ENTRY_TYPE_UPLOAD,
} from '../tokens/tokens.constants';
import { TokensService } from '../tokens/tokens.service';
import { VideoEntity } from './entities/video.entity';
import { ExportedVideoFile, VideoExportService } from './video-export.service';
import { SocialTextResult, VideoSocialService } from './video-social.service';
import { isAllowedMediaExtension, isAllowedMediaMimeType } from './video-file-validation.util';
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
  subtitlePresetId : number | null;
  socialTextCombined : string;
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

@Injectable()
export class VideosService {
  private readonly chunkSizeBytes : number = 10 * 1024 * 1024;
  private readonly uploadSessions : Map<string, UploadSession> = new Map<string, UploadSession>();
  private readonly chunkTempRoot : string = join(process.cwd(), 'data', 'upload-chunks');
  private readonly uploadsDir : string;

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    @InjectRepository(SubtitlePresetEntity)
    private readonly presetsRepository : Repository<SubtitlePresetEntity>,
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
      return await this.createFromStoredFile(
        ownerId,
        file.originalname,
        normalized.storageFileName,
        normalized.fileSizeBytes,
      );
    } catch (error : unknown) {
      if (finalStorageFileName !== file.filename) {
        const normalizedPath : string = join(this.uploadsDir, finalStorageFileName);
        await rm(normalizedPath, { force: true });
      }
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

      return video;
    } catch (error : unknown) {
      if (normalizedStorage !== null) {
        await rm(join(this.uploadsDir, normalizedStorage.storageFileName), { force: true });
      }
      await rm(finalPath, { force: true });
      this.uploadSessions.delete(dto.uploadId);
      await rm(uploadDir, { recursive: true, force: true });
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
   * Videó törlése: DB rekord + fizikai fájl eltávolítása.
   * @param ownerId User azonosító.
   * @param videoId Videó azonosító.
   * @returns Siker jelzés.
   */
  public async remove(ownerId : number, videoId : number) : Promise<{ success : boolean }> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    const mediaPath : string = join(this.uploadsDir, video.storageFileName);

    await this.videosRepository.remove(video);
    await rm(mediaPath, { force: true });

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
    if (video.processingStatus === 'queued' || video.processingStatus === 'pending') {
      throw new BadRequestException('A videó már feldolgozás alatt van vagy várólistán van.');
    }
    const requiredTokens : number = this.calculateListenTokens(video.durationSeconds);
    await this.tokensService.charge(
      ownerId,
      requiredTokens,
      TOKEN_ENTRY_TYPE_LISTEN,
      `Whisper lehallgatás: ${video.originalFileName} (${requiredTokens} token)`,
    );
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
      socialTextCombined: video.socialTextCombined ?? '',
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
      return {
        storageFileName,
        fileSizeBytes: Number(inputFileStat.size),
      };
    }

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
    const createdVideo : VideoEntity = this.videosRepository.create({
      ownerId,
      originalFileName,
      storageFileName,
      fileSizeBytes,
      durationSeconds,
      isHidden: false,
      listenRequested: false,
      subtitleText: '',
      processingStatus: 'idle',
      socialTextCombined: '',
      subtitlePresetId: null,
    });

    const savedVideo : VideoEntity = await this.videosRepository.save(createdVideo);
    return this.toVideoDetails(savedVideo);
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
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
    ];

    if (params.videoBitRate !== null) {
      ffmpegArgs.push('-b:v', this.toBitRateArgument(params.videoBitRate, 100));
    }
    if (params.audioBitRate !== null) {
      ffmpegArgs.push('-b:a', this.toBitRateArgument(params.audioBitRate, 32));
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
            reject(new BadRequestException(`A videó konvertálása sikertelen: ${details}`));
            return;
          }
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
   * Whisper lehallgatás token költség számítás: minden megkezdett perc 5 token.
   * @param durationSeconds Videó hossza másodpercben.
   * @returns Szükséges token mennyiség.
   */
  private calculateListenTokens(durationSeconds : number) : number {
    const durationMinutes : number = Math.max(1, Math.ceil(Math.max(0, durationSeconds) / 60));
    return durationMinutes * TOKEN_COST_LISTEN_PER_MINUTE;
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
