import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { execFile } from 'child_process';
import { mkdir, rm, stat } from 'fs/promises';
import { basename, extname, join } from 'path';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import {
  calculateListenTokens,
  TOKEN_COST_HIGHLIGHT_ANALYZE,
  TOKEN_COST_HIGHLIGHT_EXPORT,
  TOKEN_ENTRY_TYPE_HIGHLIGHT_ANALYZE,
  TOKEN_ENTRY_TYPE_HIGHLIGHT_EXPORT,
  TOKEN_ENTRY_TYPE_LISTEN,
} from '../tokens/tokens.constants';
import { TokensService } from '../tokens/tokens.service';
import { VideoEntity } from './entities/video.entity';
import { VideoHighlightAnalysisEntity } from './entities/video-highlight-analysis.entity';
import { VideoHighlightClipEntity } from './entities/video-highlight-clip.entity';
import { ExportHighlightClipsDto } from './dto/export-highlight-clips.dto';
import {
  applyLearningFeedback,
  HighlightFeatureReason,
  HighlightLearningProfile,
  loadHighlightLearningProfile,
  normalizeHighlightMode,
  saveHighlightLearningProfile,
  HighlightMode,
} from './video-highlights.pipeline';

export interface VideoHighlightClipDto {
  id : number;
  analysisId : number;
  rank : number;
  score : number;
  startSeconds : number;
  endSeconds : number;
  durationSeconds : number;
  screenshotUrl : string;
  transcriptSnippet : string;
  reasonSummary : string;
  reasons : HighlightFeatureReason[];
  feedbackStatus : string;
  feedbackNote : string;
  createdAt : Date;
}

export interface VideoHighlightAnalysisDto {
  id : number;
  videoId : number;
  mode : string;
  status : string;
  stageCode : string;
  stageMessage : string;
  progressPercent : number;
  requiresWhisper : boolean;
  errorMessage : string;
  createdAt : Date;
  updatedAt : Date;
  completedAt : Date | null;
  clips : VideoHighlightClipDto[];
}

export interface HighlightExportedVideoDto {
  id : number;
  originalFileName : string;
  mediaUrl : string;
  durationSeconds : number;
  createdAt : Date;
}

@Injectable()
export class VideoHighlightsService {
  private readonly logger : Logger = new Logger(VideoHighlightsService.name);
  private readonly uploadsDir : string;
  private readonly learningStorePath : string = join(process.cwd(), 'data', 'highlight-learning.json');

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    @InjectRepository(VideoHighlightAnalysisEntity)
    private readonly analysesRepository : Repository<VideoHighlightAnalysisEntity>,
    @InjectRepository(VideoHighlightClipEntity)
    private readonly clipsRepository : Repository<VideoHighlightClipEntity>,
    private readonly configService : ConfigService,
    private readonly tokensService : TokensService,
  ) {
    this.uploadsDir = resolveUploadsDir(this.configService.get<string>('UPLOADS_DIR'));
  }

  /**
   * Visszaadja az adott videó legutóbbi highlight elemzését.
   */
  public async getLatestAnalysis(ownerId : number, videoId : number) : Promise<VideoHighlightAnalysisDto | null> {
    await this.requireOwnedVideo(ownerId, videoId);
    const analysis : VideoHighlightAnalysisEntity | null = await this.analysesRepository.findOne({
      where: {
        ownerId,
        videoId,
      },
      order: {
        createdAt: 'DESC',
        id: 'DESC',
      },
    });

    if (analysis === null) {
      return null;
    }

    return await this.toAnalysisDto(analysis);
  }

  /**
   * Új highlight elemzés queue-ba helyezése.
   */
  public async startAnalysis(ownerId : number, videoId : number, mode : string | undefined) : Promise<VideoHighlightAnalysisDto> {
    const video : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    if (video.durationSeconds < 240) {
      throw new BadRequestException('A highlight keresés legalabb 4 perces videonal erheto el.');
    }

    const activeAnalysis : VideoHighlightAnalysisEntity | null = await this.analysesRepository.findOne({
      where: {
        ownerId,
        videoId,
        status: 'queued',
      },
      order: {
        createdAt: 'DESC',
      },
    });
    if (activeAnalysis !== null) {
      return await this.toAnalysisDto(activeAnalysis);
    }

    const processingAnalysis : VideoHighlightAnalysisEntity | null = await this.analysesRepository.findOne({
      where: {
        ownerId,
        videoId,
        status: 'processing',
      },
      order: {
        createdAt: 'DESC',
      },
    });
    if (processingAnalysis !== null) {
      return await this.toAnalysisDto(processingAnalysis);
    }

    const normalizedMode : HighlightMode = normalizeHighlightMode(mode);
    const requiresWhisper : boolean = video.subtitleText.trim().length === 0;
    const whisperTokenCost : number = requiresWhisper === true ? calculateListenTokens(video.durationSeconds) : 0;
    const totalTokenCost : number = TOKEN_COST_HIGHLIGHT_ANALYZE + whisperTokenCost;
    const tokenBalance = await this.tokensService.getBalance(ownerId);
    if (tokenBalance.tokenBalance < totalTokenCost) {
      throw new BadRequestException(
        `Nincs elegendő tokened a jelenetkereséshez. Szükséges: ${totalTokenCost}, jelenlegi: ${tokenBalance.tokenBalance}.`,
      );
    }

    await this.tokensService.charge(
      ownerId,
      TOKEN_COST_HIGHLIGHT_ANALYZE,
      TOKEN_ENTRY_TYPE_HIGHLIGHT_ANALYZE,
      `Jelenetek keresése: ${video.originalFileName}`,
    );
    if (whisperTokenCost > 0) {
      await this.tokensService.charge(
        ownerId,
        whisperTokenCost,
        TOKEN_ENTRY_TYPE_LISTEN,
        `Whisper lehallgatás (highlight): ${video.originalFileName} (${whisperTokenCost} token)`,
      );
    }

    this.logger.log(`Highlight elemzés queuezás. ownerId=${ownerId}, videoId=${videoId}, mode=${normalizedMode}`);
    const created : VideoHighlightAnalysisEntity = this.analysesRepository.create({
      ownerId,
      videoId,
      mode: normalizedMode,
      status: 'queued',
      stageCode: 'queued',
      stageMessage: 'Várólistán, feldolgozásra vár...',
      progressPercent: 0,
      requiresWhisper,
      errorMessage: '',
      startedAt: null,
      completedAt: null,
    });
    const saved : VideoHighlightAnalysisEntity = await this.analysesRepository.save(created);
    this.logger.log(`Highlight elemzés queuezva. analysisId=${saved.id}, ownerId=${ownerId}, videoId=${videoId}, requiresWhisper=${saved.requiresWhisper}`);
    return await this.toAnalysisDto(saved);
  }

  /**
   * Highlight klip indoklás visszajelzés mentése és tanulási súlyok frissítése.
   */
  public async updateClipFeedback(params : {
    ownerId : number;
    videoId : number;
    clipId : number;
    isAccurate : boolean;
    note ?: string;
  }) : Promise<VideoHighlightClipDto> {
    await this.requireOwnedVideo(params.ownerId, params.videoId);
    const clip : VideoHighlightClipEntity | null = await this.clipsRepository.findOne({
      where: {
        id: params.clipId,
        ownerId: params.ownerId,
        videoId: params.videoId,
      },
      relations: {
        analysis: true,
      },
    });

    if (clip === null) {
      throw new NotFoundException('A kijelolt klip nem talalhato.');
    }

    clip.feedbackStatus = params.isAccurate === true ? 'correct' : 'incorrect';
    clip.feedbackNote = params.note?.trim() ?? '';
    const saved : VideoHighlightClipEntity = await this.clipsRepository.save(clip);

    const reasons : HighlightFeatureReason[] = this.extractReasonsFromClip(saved);
    const mode : HighlightMode = normalizeHighlightMode(saved.analysis.mode);
    const profile : HighlightLearningProfile = await loadHighlightLearningProfile(this.learningStorePath);
    const updatedProfile : HighlightLearningProfile = applyLearningFeedback({
      profile,
      mode,
      reasons,
      isAccurate: params.isAccurate,
    });
    await saveHighlightLearningProfile(this.learningStorePath, updatedProfile);
    this.logger.log(
      `Highlight feedback mentve. ownerId=${params.ownerId}, videoId=${params.videoId}, clipId=${params.clipId}, accurate=${params.isAccurate}`,
    );

    return this.toClipDto(saved);
  }

  /**
   * Kijelolt highlight klipek exportja külön MP4 fájlokba és új videó rekordként mentése.
   */
  public async exportClips(ownerId : number, videoId : number, dto : ExportHighlightClipsDto) : Promise<HighlightExportedVideoDto[]> {
    const sourceVideo : VideoEntity = await this.requireOwnedVideo(ownerId, videoId);
    this.logger.log(`Highlight klip export indult. ownerId=${ownerId}, videoId=${videoId}, requestedClips=${dto.clips.length}`);
    const requestedClipIds : number[] = Array.from(new Set(dto.clips.map((item) => item.clipId)));
    const clips : VideoHighlightClipEntity[] = await this.clipsRepository.find({
      where: requestedClipIds.map((clipId : number) => ({
        id: clipId,
        ownerId,
        videoId,
      })),
      relations: {
        analysis: true,
      },
    });

    if (clips.length !== requestedClipIds.length) {
      throw new BadRequestException('A kijelolt klipek kozott ervenytelen elem szerepel.');
    }
    const requiredExportTokens : number = Math.max(1, requestedClipIds.length) * TOKEN_COST_HIGHLIGHT_EXPORT;
    await this.tokensService.charge(
      ownerId,
      requiredExportTokens,
      TOKEN_ENTRY_TYPE_HIGHLIGHT_EXPORT,
      `Highlight klip export: ${sourceVideo.originalFileName} (${requestedClipIds.length} klip)`,
    );

    const byClipId : Map<number, VideoHighlightClipEntity> = new Map<number, VideoHighlightClipEntity>(
      clips.map((clip : VideoHighlightClipEntity) => [clip.id, clip]),
    );

    const sourcePath : string = join(this.uploadsDir, sourceVideo.storageFileName);
    const bitRates : { videoBitRate : number | null; audioBitRate : number | null } = await this.probeBitRates(sourcePath);
    const highlightsDir : string = join(this.uploadsDir, 'highlights');
    await mkdir(highlightsDir, { recursive: true });

    const exportedVideos : HighlightExportedVideoDto[] = [];
    let index : number = 1;

    for (const requested of dto.clips) {
      const clip : VideoHighlightClipEntity | undefined = byClipId.get(requested.clipId);
      if (clip === undefined) {
        continue;
      }

      const safeStart : number = this.normalizeSeconds(
        requested.startSeconds ?? clip.startSeconds,
        clip.startSeconds,
        clip.endSeconds - 0.1,
      );
      const safeEnd : number = this.normalizeSeconds(
        requested.endSeconds ?? clip.endSeconds,
        safeStart + 0.1,
        sourceVideo.durationSeconds,
      );

      if (safeEnd <= safeStart) {
        throw new BadRequestException('A klip vegpontja nem lehet kisebb vagy egyenlo a kezdo ponttal.');
      }

      const outputFileName : string = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}.mp4`;
      const outputRelativePath : string = `highlights/${outputFileName}`;
      const outputPath : string = join(this.uploadsDir, outputRelativePath);

      await this.extractClipToMp4({
        inputPath: sourcePath,
        outputPath,
        startSeconds: safeStart,
        endSeconds: safeEnd,
        videoBitRate: bitRates.videoBitRate,
        audioBitRate: bitRates.audioBitRate,
      });

      const outputStat = await stat(outputPath);
      const clipDurationSeconds : number = await this.detectDurationSeconds(outputPath);
      const originalBase : string = basename(sourceVideo.originalFileName, extname(sourceVideo.originalFileName));
      const newOriginalName : string = `${originalBase}-highlight-${index}.mp4`;
      const thumbnailFileName : string = await this.generateThumbnailForVideo(outputRelativePath, clipDurationSeconds);

      let savedVideo : VideoEntity;
      try {
        const createdVideo : VideoEntity = this.videosRepository.create({
          ownerId,
          originalFileName: newOriginalName,
          storageFileName: outputRelativePath,
          thumbnailFileName,
          fileSizeBytes: Number(outputStat.size),
          durationSeconds: clipDurationSeconds,
          isHidden: false,
          listenRequested: false,
          subtitleText: '',
          processingStatus: 'idle',
          socialTextCombined: '',
          subtitlePresetId: null,
        });

        savedVideo = await this.videosRepository.save(createdVideo);
      } catch (error : unknown) {
        if (thumbnailFileName.length > 0) {
          await rm(join(this.uploadsDir, thumbnailFileName), { force: true });
        }
        await rm(outputPath, { force: true });
        throw error;
      }
      this.logger.log(
        `Highlight klip export kész. ownerId=${ownerId}, sourceVideoId=${videoId}, newVideoId=${savedVideo.id}, clipId=${requested.clipId}, start=${safeStart}, end=${safeEnd}, thumbnail="${
          thumbnailFileName.length > 0 ? thumbnailFileName : 'none'
        }"`,
      );
      exportedVideos.push({
        id: savedVideo.id,
        originalFileName: savedVideo.originalFileName,
        mediaUrl: `/api/uploads/${savedVideo.storageFileName}`,
        durationSeconds: savedVideo.durationSeconds,
        createdAt: savedVideo.createdAt,
      });

      index += 1;
    }

    this.logger.log(`Highlight klip export lezárva. ownerId=${ownerId}, sourceVideoId=${videoId}, createdVideos=${exportedVideos.length}`);
    return exportedVideos;
  }

  /**
   * Worker oldali queue lekérdezéshez visszaadja a legrégebbi queued elemzést.
   */
  public async findNextQueuedAnalysis() : Promise<VideoHighlightAnalysisEntity | null> {
    return await this.analysesRepository.findOne({
      where: {
        status: 'queued',
      },
      order: {
        createdAt: 'ASC',
        id: 'ASC',
      },
    });
  }

  /**
   * Elemzés állapotfrissítés workerből.
   */
  public async updateAnalysisStatus(analysisId : number, patch : Partial<VideoHighlightAnalysisEntity>) : Promise<void> {
    const analysis : VideoHighlightAnalysisEntity | null = await this.analysesRepository.findOne({ where: { id: analysisId } });
    if (analysis === null) {
      return;
    }

    Object.assign(analysis, patch);
    await this.analysesRepository.save(analysis);
  }

  /**
   * Elemzéshez tartozó klipek cseréje workerből.
   */
  public async replaceAnalysisClips(analysisId : number, clips : Array<{
    ownerId : number;
    videoId : number;
    rank : number;
    score : number;
    startSeconds : number;
    endSeconds : number;
    screenshotFileName : string;
    transcriptSnippet : string;
    reasonsJson : string;
  }>) : Promise<void> {
    await this.clipsRepository.delete({ analysisId });

    if (clips.length === 0) {
      return;
    }

    const entities : VideoHighlightClipEntity[] = clips.map((clip) => {
      return this.clipsRepository.create({
        analysisId,
        ownerId: clip.ownerId,
        videoId: clip.videoId,
        rank: clip.rank,
        score: clip.score,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        screenshotFileName: clip.screenshotFileName,
        transcriptSnippet: clip.transcriptSnippet,
        reasonsJson: clip.reasonsJson,
        feedbackStatus: 'unset',
        feedbackNote: '',
      });
    });

    await this.clipsRepository.save(entities);
  }

  private async toAnalysisDto(analysis : VideoHighlightAnalysisEntity) : Promise<VideoHighlightAnalysisDto> {
    const clips : VideoHighlightClipEntity[] = await this.clipsRepository.find({
      where: {
        analysisId: analysis.id,
      },
      order: {
        rank: 'ASC',
        score: 'DESC',
        id: 'ASC',
      },
    });

    return {
      id: analysis.id,
      videoId: analysis.videoId,
      mode: normalizeHighlightMode(analysis.mode),
      status: analysis.status,
      stageCode: analysis.stageCode,
      stageMessage: analysis.stageMessage,
      progressPercent: Math.min(100, Math.max(0, Math.round(analysis.progressPercent))),
      requiresWhisper: analysis.requiresWhisper,
      errorMessage: analysis.errorMessage,
      createdAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      completedAt: analysis.completedAt ?? null,
      clips: clips.map((clip : VideoHighlightClipEntity) => this.toClipDto(clip)),
    };
  }

  private toClipDto(clip : VideoHighlightClipEntity) : VideoHighlightClipDto {
    const reasons : HighlightFeatureReason[] = this.extractReasonsFromClip(clip);
    const parsedReasonsRecord : Record<string, unknown> = this.parseReasonsRecord(clip.reasonsJson);
    const reasonSummary : string = this.readReasonSummary(parsedReasonsRecord, reasons);

    return {
      id: clip.id,
      analysisId: clip.analysisId,
      rank: clip.rank,
      score: clip.score,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationSeconds: Number(Math.max(0, clip.endSeconds - clip.startSeconds).toFixed(3)),
      screenshotUrl: clip.screenshotFileName.length > 0 ? `/api/uploads/${clip.screenshotFileName}` : '',
      transcriptSnippet: clip.transcriptSnippet,
      reasonSummary,
      reasons,
      feedbackStatus: clip.feedbackStatus,
      feedbackNote: clip.feedbackNote,
      createdAt: clip.createdAt,
    };
  }

  private parseReasonsRecord(reasonsJson : string) : Record<string, unknown> {
    try {
      const parsed : unknown = JSON.parse(reasonsJson) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private readReasonSummary(parsedReasonsRecord : Record<string, unknown>, fallbackReasons : HighlightFeatureReason[]) : string {
    const reasonSummaryValue : unknown = parsedReasonsRecord['reasonSummary'];
    if (typeof reasonSummaryValue === 'string' && reasonSummaryValue.trim().length > 0) {
      return reasonSummaryValue.trim();
    }

    if (fallbackReasons.length === 0) {
      return '';
    }

    return fallbackReasons.slice(0, 3).map((reason : HighlightFeatureReason) => reason.label).join(' | ');
  }

  private extractReasonsFromClip(clip : VideoHighlightClipEntity) : HighlightFeatureReason[] {
    const record : Record<string, unknown> = this.parseReasonsRecord(clip.reasonsJson);
    const reasonsValue : unknown = record['reasons'];
    if (Array.isArray(reasonsValue) === false) {
      return [];
    }

    return reasonsValue
      .map((item : unknown) => this.toReason(item))
      .filter((reason : HighlightFeatureReason | null) : reason is HighlightFeatureReason => reason !== null);
  }

  private toReason(value : unknown) : HighlightFeatureReason | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const record : Record<string, unknown> = value as Record<string, unknown>;
    const key : string | null = this.readString(record['key']);
    const label : string | null = this.readString(record['label']);
    const explanation : string | null = this.readString(record['explanation']);
    if (key === null || label === null || explanation === null) {
      return null;
    }

    return {
      key,
      label,
      explanation,
      value: this.readNumber(record['value']),
      normalized: this.readNumber(record['normalized']),
      weight: this.readNumber(record['weight']),
      contribution: this.readNumber(record['contribution']),
    };
  }

  private readString(value : unknown) : string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed : string = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readNumber(value : unknown) : number {
    const parsed : number = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async requireOwnedVideo(ownerId : number, videoId : number) : Promise<VideoEntity> {
    const video : VideoEntity | null = await this.videosRepository.findOne({
      where: {
        id: videoId,
        ownerId,
      },
    });

    if (video === null) {
      throw new NotFoundException('A video nem talalhato.');
    }

    return video;
  }

  private normalizeSeconds(value : number, min : number, max : number) : number {
    const safeNumber : number = Number(value);
    if (Number.isFinite(safeNumber) === false) {
      return min;
    }
    const clamped : number = Math.max(min, Math.min(max, safeNumber));
    return Number(clamped.toFixed(3));
  }

  private async extractClipToMp4(params : {
    inputPath : string;
    outputPath : string;
    startSeconds : number;
    endSeconds : number;
    videoBitRate : number | null;
    audioBitRate : number | null;
  }) : Promise<void> {
    const ffmpegArgs : string[] = [
      '-y',
      '-ss',
      String(params.startSeconds),
      '-to',
      String(params.endSeconds),
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
      ffmpegArgs.push('-b:v', this.toBitRateArg(params.videoBitRate, 100));
    }
    if (params.audioBitRate !== null) {
      ffmpegArgs.push('-b:a', this.toBitRateArg(params.audioBitRate, 32));
    }

    ffmpegArgs.push(params.outputPath);

    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      execFile('ffmpeg', ffmpegArgs, { timeout: 0 }, (error : Error | null, stdout : string, stderr : string) => {
        if (error !== null) {
          reject(new BadRequestException(`Klip export sikertelen: ${stdout}\n${stderr}`.trim()));
          return;
        }
        resolve();
      });
    });
  }

  private toBitRateArg(bitRate : number, minKbps : number) : string {
    const kbps : number = Math.max(minKbps, Math.round(bitRate / 1000));
    return `${kbps}k`;
  }

  private async probeBitRates(inputPath : string) : Promise<{ videoBitRate : number | null; audioBitRate : number | null }> {
    const probeOutput : string | null = await this.execTool('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      inputPath,
    ]);

    if (probeOutput === null) {
      return { videoBitRate: null, audioBitRate: null };
    }

    try {
      const parsed : unknown = JSON.parse(probeOutput) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return { videoBitRate: null, audioBitRate: null };
      }
      const root : Record<string, unknown> = parsed as Record<string, unknown>;
      const streamsValue : unknown = root['streams'];
      const streams : Record<string, unknown>[] = Array.isArray(streamsValue)
        ? streamsValue.filter((item : unknown) => typeof item === 'object' && item !== null) as Record<string, unknown>[]
        : [];

      const videoStream : Record<string, unknown> | undefined = streams.find((stream : Record<string, unknown>) => stream['codec_type'] === 'video');
      const audioStream : Record<string, unknown> | undefined = streams.find((stream : Record<string, unknown>) => stream['codec_type'] === 'audio');

      return {
        videoBitRate: this.readBitRate(videoStream?.['bit_rate']),
        audioBitRate: this.readBitRate(audioStream?.['bit_rate']),
      };
    } catch {
      return { videoBitRate: null, audioBitRate: null };
    }
  }

  private readBitRate(value : unknown) : number | null {
    const numeric : number = Number(value);
    if (Number.isFinite(numeric) === false) {
      return null;
    }
    const rounded : number = Math.round(numeric);
    if (rounded <= 0) {
      return null;
    }
    return rounded;
  }

  private async detectDurationSeconds(inputPath : string) : Promise<number> {
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
      return 0;
    }

    const parsed : number = Number(output.trim());
    if (Number.isFinite(parsed) === false || parsed <= 0) {
      return 0;
    }

    return Math.max(0, Math.round(parsed));
  }

  /**
   * Thumbnail képet készít a videó 0. másodpercéből.
   * Rövid videónál biztonságos fallback időpontra ugrik.
   * @param storageFileName Tárolt videófájl neve.
   * @param durationSeconds Videó hossza másodpercben.
   * @returns Relatív thumbnail fájlnév vagy üres string, ha nem sikerült.
   */
  private async generateThumbnailForVideo(storageFileName : string, durationSeconds : number) : Promise<string> {
    const sourcePath : string = join(this.uploadsDir, storageFileName);
    const thumbnailsDir : string = join(this.uploadsDir, 'thumbnails');
    await mkdir(thumbnailsDir, { recursive: true });

    const seekSeconds : number = 0;
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
      this.logger.log(`Highlight thumbnail elkészült. source="${storageFileName}", seekSec=${seekSeconds.toFixed(2)}, file="${relativePath}"`);
      return relativePath;
    } catch (error : unknown) {
      const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.warn(`Highlight thumbnail készítés sikertelen. source="${storageFileName}", details=${details}`);
      await rm(outputPath, { force: true });
      return '';
    }
  }

  private async execTool(command : string, args : string[]) : Promise<string | null> {
    return await new Promise<string | null>((resolve : (value : string | null) => void) => {
      execFile(command, args, { timeout: 20_000 }, (error : Error | null, stdout : string, stderr : string) => {
        if (error !== null) {
          const fallback : string = `${stdout}\n${stderr}`.trim();
          resolve(fallback.length > 0 ? fallback : null);
          return;
        }

        const output : string = `${stdout}\n${stderr}`.trim();
        resolve(output.length > 0 ? output : null);
      });
    });
  }
}
