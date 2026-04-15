import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { basename, dirname, extname, join } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { access, constants } from 'fs';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { UserEntity } from '../users/entities/user.entity';
import { VideoHighlightAnalysisEntity } from '../videos/entities/video-highlight-analysis.entity';
import { VideoHighlightClipEntity } from '../videos/entities/video-highlight-clip.entity';
import { VideoEntity } from '../videos/entities/video.entity';
import { analyzeHighlightCandidates, HighlightCandidate, loadHighlightLearningProfile, normalizeHighlightMode } from '../videos/video-highlights.pipeline';
import { LocalAiRerankOptions, rerankHighlightCandidatesWithLocalAi } from '../videos/highlight-ai-reranker';

interface WhisperResult {
  transcript : string;
  log : string;
}

const DEFAULT_WHISPER_MODEL : string = 'turbo';
const DEFAULT_WHISPER_LANGUAGE : string = 'hu';
const DEFAULT_WORDS_PER_LINE : number = 7;
const DEFAULT_HIGHLIGHT_MAX_RESULTS : number = 8;
const DEFAULT_HIGHLIGHT_AI_TIMEOUT_MS : number = 90_000;
const DEFAULT_HIGHLIGHT_AI_BLEND : number = 0.8;
const DEFAULT_HIGHLIGHT_AI_PYTHON_COMMAND : string = 'python3';
const DEFAULT_HIGHLIGHT_AI_MODEL : string = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const DEFAULT_SQLITE_BUSY_RETRY_ATTEMPTS : number = 6;
const DEFAULT_SQLITE_BUSY_RETRY_DELAY_MS : number = 450;

interface SqliteBusyRetryConfig {
  attempts : number;
  delayMs : number;
}

function workerLog(message : string) : void {
  console.log(`[WhisperWorker] ${message}`);
}

function workerWarn(message : string) : void {
  console.warn(`[WhisperWorker] ${message}`);
}

function workerError(message : string, error ?: unknown) : void {
  if (error === undefined) {
    console.error(`[WhisperWorker] ${message}`);
    return;
  }
  console.error(`[WhisperWorker] ${message}`, error);
}

/**
 * Folyamatos háttér worker, ami a queue-ba tett videókat Whisperrel feldolgozza.
 * Külön child processben fut, így nem terheli a HTTP szerver fő szálát.
 */
export async function runWhisperWorkerProcess() : Promise<void> {
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const configService : ConfigService = appContext.get(ConfigService);
  const videosRepository : Repository<VideoEntity> = appContext.get<Repository<VideoEntity>>(getRepositoryToken(VideoEntity));
  const usersRepository : Repository<UserEntity> = appContext.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
  const analysesRepository : Repository<VideoHighlightAnalysisEntity> = appContext.get<Repository<VideoHighlightAnalysisEntity>>(
    getRepositoryToken(VideoHighlightAnalysisEntity),
  );
  const uploadsDir : string = resolveUploadsDir(configService.get<string>('UPLOADS_DIR'));
  const learningStorePath : string = join(process.cwd(), 'data', 'highlight-learning.json');
  const pollMs : number = Number(configService.get<string>('WHISPER_QUEUE_POLL_MS') ?? '2500');
  const sqliteBusyRetryConfig : SqliteBusyRetryConfig = {
    attempts: normalizePositiveInteger(
      configService.get<string>('DB_BUSY_RETRY_ATTEMPTS') ?? process.env.DB_BUSY_RETRY_ATTEMPTS,
      DEFAULT_SQLITE_BUSY_RETRY_ATTEMPTS,
    ),
    delayMs: normalizePositiveInteger(
      configService.get<string>('DB_BUSY_RETRY_DELAY_MS') ?? process.env.DB_BUSY_RETRY_DELAY_MS,
      DEFAULT_SQLITE_BUSY_RETRY_DELAY_MS,
    ),
  };
  const whisperCommand : string = await resolveWhisperCommand(configService);
  const highlightAiPythonCommand : string = await resolveHighlightAiPythonCommand(configService, whisperCommand);
  const localAiRerankOptions : LocalAiRerankOptions = {
    enabled: normalizeBooleanFlag(
      configService.get<string>('HIGHLIGHT_AI_ENABLED') ?? process.env.HIGHLIGHT_AI_ENABLED,
      true,
    ),
    pythonCommand: highlightAiPythonCommand,
    scriptPath: normalizeNonEmptyString(
      configService.get<string>('HIGHLIGHT_AI_SCRIPT_PATH') ?? process.env.HIGHLIGHT_AI_SCRIPT_PATH,
      join(__dirname, '..', '..', 'scripts', 'highlight-rerank.py'),
    ),
    timeoutMs: normalizePositiveInteger(
      configService.get<string>('HIGHLIGHT_AI_TIMEOUT_MS') ?? process.env.HIGHLIGHT_AI_TIMEOUT_MS,
      DEFAULT_HIGHLIGHT_AI_TIMEOUT_MS,
    ),
    aiBlend: normalizeBlendValue(
      configService.get<string>('HIGHLIGHT_AI_BLEND') ?? process.env.HIGHLIGHT_AI_BLEND,
      DEFAULT_HIGHLIGHT_AI_BLEND,
    ),
    modelName: normalizeNonEmptyString(
      configService.get<string>('HIGHLIGHT_AI_MODEL') ?? process.env.HIGHLIGHT_AI_MODEL,
      DEFAULT_HIGHLIGHT_AI_MODEL,
    ),
  };
  workerLog(
    `Highlight AI: enabled=${localAiRerankOptions.enabled}, python="${localAiRerankOptions.pythonCommand}", script="${localAiRerankOptions.scriptPath}", blend=${localAiRerankOptions.aiBlend}, timeoutMs=${localAiRerankOptions.timeoutMs}, model=${localAiRerankOptions.modelName}`,
  );
  let stopRequested : boolean = false;
  const requestStop = () : void => {
    stopRequested = true;
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  process.on('disconnect', requestStop);
  workerLog(`Használt whisper parancs: ${whisperCommand}`);
  await requeuePendingVideosOnStartup(videosRepository, sqliteBusyRetryConfig);
  await requeueProcessingHighlightAnalysesOnStartup(analysesRepository, sqliteBusyRetryConfig);

  // Egyszerre egy feladatot futtatunk, FIFO jelleggel.
  // Több worker process esetén külön lockolás szükséges.
  while (stopRequested === false) {
    try {
      const queuedVideo : VideoEntity | null = await executeWithSqliteBusyRetry(
        'queued whisper video lekérdezés',
        sqliteBusyRetryConfig,
        async () : Promise<VideoEntity | null> => await videosRepository.findOne({
          where: {
            listenRequested: true,
            processingStatus: 'queued',
          },
          order: {
            updatedAt: 'ASC',
            id: 'ASC',
          },
        }),
      );
      const queuedHighlight : VideoHighlightAnalysisEntity | null = await executeWithSqliteBusyRetry(
        'queued highlight elemzés lekérdezés',
        sqliteBusyRetryConfig,
        async () : Promise<VideoHighlightAnalysisEntity | null> => await analysesRepository.findOne({
          where: {
            status: 'queued',
          },
          order: {
            createdAt: 'ASC',
            id: 'ASC',
          },
        }),
      );

      if (queuedVideo === null && queuedHighlight === null) {
        await delay(pollMs);
        continue;
      }

      const shouldProcessHighlightFirst : boolean = shouldProcessHighlightBeforeWhisper(queuedHighlight, queuedVideo);
      if (shouldProcessHighlightFirst === true && queuedHighlight !== null) {
        workerLog(`Highlight queue elem kiválasztva. analysisId=${queuedHighlight.id}, videoId=${queuedHighlight.videoId}, ownerId=${queuedHighlight.ownerId}`);
        await processQueuedHighlightAnalysis({
          analysis: queuedHighlight,
          analysesRepository,
          videosRepository,
          usersRepository,
          uploadsDir,
          whisperCommand,
          learningStorePath,
          localAiRerankOptions,
          sqliteBusyRetryConfig,
        });
        continue;
      }

      if (queuedVideo !== null) {
        workerLog(`Whisper queue elem kiválasztva. videoId=${queuedVideo.id}, ownerId=${queuedVideo.ownerId}, stored="${queuedVideo.storageFileName}"`);
        await processQueuedWhisperVideo({
          video: queuedVideo,
          videosRepository,
          usersRepository,
          uploadsDir,
          whisperCommand,
          sqliteBusyRetryConfig,
        });
      }
    } catch (error : unknown) {
      if (isSqliteBusyError(error) === true) {
        workerWarn('SQLite lock érzékelve a worker ciklusban, rövid várakozás után újrapróba.');
      } else {
        workerError('Feldolgozási hiba.', error);
      }

      // Hiba esetén ne maradjon beragadva pending állapotban.
      try {
        await recoverStuckPendingVideo(videosRepository, sqliteBusyRetryConfig);
        await recoverStuckHighlightAnalysis(analysesRepository, sqliteBusyRetryConfig);
      } catch (recoveryError : unknown) {
        const details : string = recoveryError instanceof Error ? recoveryError.message : 'ismeretlen hiba';
        workerWarn(`Recovery lépés közben hiba történt (kihagyva): ${details}`);
      }
      await delay(Math.max(1000, pollMs));
    }
  }

  await appContext.close();
}

function normalizeWhisperLanguage(language : string | undefined | null) : string {
  if (typeof language !== 'string') {
    return DEFAULT_WHISPER_LANGUAGE;
  }
  const normalized : string = language.trim();
  if (normalized.length === 0) {
    return DEFAULT_WHISPER_LANGUAGE;
  }
  return normalized;
}

function normalizeWordsPerLine(wordsPerLine : number | undefined | null) : number {
  if (Number.isInteger(wordsPerLine) === false || wordsPerLine === null || wordsPerLine === undefined) {
    return DEFAULT_WORDS_PER_LINE;
  }
  return Math.min(30, Math.max(1, wordsPerLine));
}

function normalizeBooleanFlag(raw : string | undefined | null, fallback : boolean) : boolean {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized : string = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePositiveInteger(raw : string | undefined | null, fallback : number) : number {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const parsed : number = Number(raw);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function normalizeBlendValue(raw : string | undefined | null, fallback : number) : number {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const parsed : number = Number(raw);
  if (Number.isFinite(parsed) === false) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function normalizeNonEmptyString(raw : string | undefined | null, fallback : string) : string {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized : string = raw.trim();
  if (normalized.length === 0) {
    return fallback;
  }
  return normalized;
}

function shouldProcessHighlightBeforeWhisper(
  queuedHighlight : VideoHighlightAnalysisEntity | null,
  queuedVideo : VideoEntity | null,
) : boolean {
  if (queuedHighlight === null) {
    return false;
  }
  if (queuedVideo === null) {
    return true;
  }
  return queuedHighlight.createdAt.getTime() <= queuedVideo.updatedAt.getTime();
}

async function processQueuedWhisperVideo(params : {
  video : VideoEntity;
  videosRepository : Repository<VideoEntity>;
  usersRepository : Repository<UserEntity>;
  uploadsDir : string;
  whisperCommand : string;
  sqliteBusyRetryConfig : SqliteBusyRetryConfig;
}) : Promise<void> {
  const { video, videosRepository, usersRepository, uploadsDir, whisperCommand, sqliteBusyRetryConfig } = params;
  const startedAt : number = Date.now();
  video.processingStatus = 'pending';
  await executeWithSqliteBusyRetry('whisper queue elem pending mentés', sqliteBusyRetryConfig, async () : Promise<VideoEntity> => await videosRepository.save(video));

  const owner : UserEntity | null = await executeWithSqliteBusyRetry(
    'whisper owner lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<UserEntity | null> => await usersRepository.findOne({
      where: { id: video.ownerId },
    }),
  );

  const mediaPath : string = join(uploadsDir, video.storageFileName);
  const whisperResult : WhisperResult = await runWhisperForVideo({
    whisperCommand,
    mediaPath,
    model: DEFAULT_WHISPER_MODEL,
    language: normalizeWhisperLanguage(owner?.whisperLanguage),
    wordsPerLine: normalizeWordsPerLine(owner?.wordsPerLine),
  });

  video.subtitleText = normalizeTranscriptText(whisperResult.transcript);
  video.processingStatus = 'idle';
  video.listenRequested = false;
  await executeWithSqliteBusyRetry('whisper eredmény mentés', sqliteBusyRetryConfig, async () : Promise<VideoEntity> => await videosRepository.save(video));
  workerLog(
    `Whisper kész. videoId=${video.id}, ownerId=${video.ownerId}, transcriptChars=${video.subtitleText.length}, elapsedMs=${Date.now() - startedAt}`,
  );
}

async function processQueuedHighlightAnalysis(params : {
  analysis : VideoHighlightAnalysisEntity;
  analysesRepository : Repository<VideoHighlightAnalysisEntity>;
  videosRepository : Repository<VideoEntity>;
  usersRepository : Repository<UserEntity>;
  uploadsDir : string;
  whisperCommand : string;
  learningStorePath : string;
  localAiRerankOptions : LocalAiRerankOptions;
  sqliteBusyRetryConfig : SqliteBusyRetryConfig;
}) : Promise<void> {
  const {
    analysis,
    analysesRepository,
    videosRepository,
    usersRepository,
    uploadsDir,
    whisperCommand,
    learningStorePath,
    localAiRerankOptions,
    sqliteBusyRetryConfig,
  } = params;

  const managedAnalysis : VideoHighlightAnalysisEntity | null = await executeWithSqliteBusyRetry(
    'highlight analysis rekord lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity | null> => await analysesRepository.findOne({
      where: { id: analysis.id },
    }),
  );
  if (managedAnalysis === null) {
    return;
  }
  if (managedAnalysis.status !== 'queued') {
    return;
  }

  const startedAt : number = Date.now();

  managedAnalysis.status = 'processing';
  managedAnalysis.stageCode = 'preparing';
  managedAnalysis.stageMessage = 'Elemzés előkészítése...';
  managedAnalysis.progressPercent = 6;
  managedAnalysis.errorMessage = '';
  managedAnalysis.startedAt = new Date();
  managedAnalysis.completedAt = null;
  await executeWithSqliteBusyRetry(
    'highlight analysis induló státusz mentés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
  );
  workerLog(`Highlight feldolgozás indult. analysisId=${managedAnalysis.id}, videoId=${managedAnalysis.videoId}, ownerId=${managedAnalysis.ownerId}`);

  try {
    const video : VideoEntity | null = await executeWithSqliteBusyRetry(
      'highlight forrás videó lekérdezés',
      sqliteBusyRetryConfig,
      async () : Promise<VideoEntity | null> => await videosRepository.findOne({
        where: {
          id: managedAnalysis.videoId,
          ownerId: managedAnalysis.ownerId,
        },
      }),
    );
    if (video === null) {
      throw new Error('A highlight elemzéshez tartozó videó nem található.');
    }

    const mediaPath : string = join(uploadsDir, video.storageFileName);
    let transcript : string = video.subtitleText.trim();

    if (transcript.length === 0) {
      workerLog(`Highlight elemzéshez hiányzik transcript, Whisper indul. analysisId=${managedAnalysis.id}, videoId=${video.id}`);
      managedAnalysis.requiresWhisper = true;
      managedAnalysis.stageCode = 'whisper';
      managedAnalysis.stageMessage = 'Whisper átirat készítése folyamatban...';
      managedAnalysis.progressPercent = 24;
      await executeWithSqliteBusyRetry(
        'highlight whisper státusz mentés',
        sqliteBusyRetryConfig,
        async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
      );

      const owner : UserEntity | null = await executeWithSqliteBusyRetry(
        'highlight owner lekérdezés',
        sqliteBusyRetryConfig,
        async () : Promise<UserEntity | null> => await usersRepository.findOne({
          where: { id: video.ownerId },
        }),
      );

      const whisperResult : WhisperResult = await runWhisperForVideo({
        whisperCommand,
        mediaPath,
        model: DEFAULT_WHISPER_MODEL,
        language: normalizeWhisperLanguage(owner?.whisperLanguage),
        wordsPerLine: normalizeWordsPerLine(owner?.wordsPerLine),
      });

      transcript = normalizeTranscriptText(whisperResult.transcript);
      video.subtitleText = transcript;
      await executeWithSqliteBusyRetry(
        'highlight whisper transcript mentés',
        sqliteBusyRetryConfig,
        async () : Promise<VideoEntity> => await videosRepository.save(video),
      );
      workerLog(`Whisper fallback kész highlight előtt. analysisId=${managedAnalysis.id}, videoId=${video.id}, transcriptChars=${transcript.length}`);
    } else {
      managedAnalysis.requiresWhisper = false;
    }

    managedAnalysis.stageCode = 'analysis';
    managedAnalysis.stageMessage = 'NLP alapú jelenetelemzés fut...';
    managedAnalysis.progressPercent = 58;
    await executeWithSqliteBusyRetry(
      'highlight analysis státusz mentés',
      sqliteBusyRetryConfig,
      async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
    );

    const learningProfile = await loadHighlightLearningProfile(learningStorePath);
    let candidates : HighlightCandidate[] = analyzeHighlightCandidates({
      transcript,
      durationSeconds: video.durationSeconds,
      mode: normalizeHighlightMode(managedAnalysis.mode),
      learningProfile,
      maxResults: DEFAULT_HIGHLIGHT_MAX_RESULTS,
    });
    workerLog(
      `Highlight jelöltkeresés kész. analysisId=${managedAnalysis.id}, videoId=${video.id}, candidates=${candidates.length}, mode=${normalizeHighlightMode(
        managedAnalysis.mode,
      )}`,
    );

    if (localAiRerankOptions.enabled === true && candidates.length > 0) {
      managedAnalysis.stageCode = 'semantic_rerank';
      managedAnalysis.stageMessage = 'Lokalis AI ujrapontozas fut...';
      managedAnalysis.progressPercent = 68;
      await executeWithSqliteBusyRetry(
        'highlight rerank státusz mentés',
        sqliteBusyRetryConfig,
        async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
      );

      const reranked = await rerankHighlightCandidatesWithLocalAi({
        candidates,
        mode: normalizeHighlightMode(managedAnalysis.mode),
        options: localAiRerankOptions,
      });
      candidates = reranked.candidates;
      if (reranked.used === true) {
        workerLog(
          `Highlight AI ujrapontozas kesz. analysisId=${managedAnalysis.id}, videoId=${video.id}, details=${reranked.details}`,
        );
      } else {
        workerWarn(
          `Highlight AI ujrapontozas kihagyva/fallback. analysisId=${managedAnalysis.id}, videoId=${video.id}, details=${reranked.details}`,
        );
      }
    }

    managedAnalysis.stageCode = 'screenshots';
    managedAnalysis.stageMessage = 'Előnézeti képek készítése...';
    managedAnalysis.progressPercent = 77;
    await executeWithSqliteBusyRetry(
      'highlight screenshot státusz mentés',
      sqliteBusyRetryConfig,
      async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
    );

    const previewDir : string = join(uploadsDir, 'highlight-previews');
    await mkdir(previewDir, { recursive: true });

    const clipEntitiesPayload : Array<{
      ownerId : number;
      videoId : number;
      rank : number;
      score : number;
      startSeconds : number;
      endSeconds : number;
      screenshotFileName : string;
      transcriptSnippet : string;
      reasonsJson : string;
    }> = [];

    for (const [index, candidate] of candidates.entries()) {
      const rank : number = index + 1;
      const middleSeconds : number = Number(((candidate.startSeconds + candidate.endSeconds) / 2).toFixed(3));
      const previewFileName : string = `${managedAnalysis.id}-${rank}-${Date.now()}.jpg`;
      const previewRelativePath : string = `highlight-previews/${previewFileName}`;
      const previewAbsolutePath : string = join(uploadsDir, previewRelativePath);

      await captureScreenshot({
        inputPath: mediaPath,
        outputPath: previewAbsolutePath,
        atSeconds: middleSeconds,
      });

      clipEntitiesPayload.push({
        ownerId: managedAnalysis.ownerId,
        videoId: managedAnalysis.videoId,
        rank,
        score: Number(candidate.score.toFixed(4)),
        startSeconds: Number(candidate.startSeconds.toFixed(3)),
        endSeconds: Number(candidate.endSeconds.toFixed(3)),
        screenshotFileName: previewRelativePath,
        transcriptSnippet: candidate.transcriptSnippet,
        reasonsJson: JSON.stringify({
          mode: normalizeHighlightMode(managedAnalysis.mode),
          score: candidate.score,
          reasonSummary: candidate.reasonSummary,
          reasons: candidate.reasons,
        }),
      });
    }

    await executeWithSqliteBusyRetry(
      'highlight tranzakciós mentés',
      sqliteBusyRetryConfig,
      async () : Promise<void> => {
        await analysesRepository.manager.transaction(async (manager) => {
          await manager.getRepository(VideoHighlightAnalysisEntity).update(
            { id: managedAnalysis.id },
            {
              stageCode: 'finalizing',
              stageMessage: 'Javaslatok mentése folyamatban...',
              progressPercent: 92,
            },
          );
          await manager.getRepository(VideoHighlightClipEntity).delete({ analysisId: managedAnalysis.id });
          if (clipEntitiesPayload.length > 0) {
            await manager.getRepository(VideoHighlightClipEntity).insert(
              clipEntitiesPayload.map((clip) => ({
                analysisId: managedAnalysis.id,
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
              })),
            );
          }
          await manager.getRepository(VideoHighlightAnalysisEntity).update(
            { id: managedAnalysis.id },
            {
              status: 'completed',
              stageCode: 'completed',
              stageMessage: clipEntitiesPayload.length > 0 ? 'Elemzés elkészült.' : 'Elemzés elkészült, de nem talált erős jelölteket.',
              progressPercent: 100,
              completedAt: new Date(),
            },
          );
        });
      },
    );
    workerLog(
      `Highlight feldolgozás kész. analysisId=${managedAnalysis.id}, videoId=${managedAnalysis.videoId}, clips=${clipEntitiesPayload.length}, elapsedMs=${
        Date.now() - startedAt
      }`,
    );
  } catch (error : unknown) {
    const message : string = error instanceof Error ? error.message : 'Ismeretlen hiba';
    managedAnalysis.status = 'failed';
    managedAnalysis.stageCode = 'failed';
    managedAnalysis.stageMessage = 'A highlight elemzés hibával leállt.';
    managedAnalysis.errorMessage = message;
    managedAnalysis.progressPercent = 100;
    managedAnalysis.completedAt = new Date();
    await executeWithSqliteBusyRetry(
      'highlight hibás státusz mentés',
      sqliteBusyRetryConfig,
      async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(managedAnalysis),
    );
    workerError(
      `Highlight feldolgozás hiba. analysisId=${managedAnalysis.id}, videoId=${managedAnalysis.videoId}, details=${message}`,
      error,
    );
    throw error;
  }
}

async function captureScreenshot(params : { inputPath : string; outputPath : string; atSeconds : number }) : Promise<void> {
  const { inputPath, outputPath, atSeconds } = params;
  const args : string[] = [
    '-y',
    '-ss',
    String(Math.max(0, atSeconds)),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outputPath,
  ];

  await execSpawn('ffmpeg', args);
}

/**
 * Elindítja a whisper CLI-t és visszaadja a kiolvasott SRT szöveget.
 */
async function runWhisperForVideo(params : {
  whisperCommand : string;
  mediaPath : string;
  model : string;
  language : string;
  wordsPerLine : number;
}) : Promise<WhisperResult> {
  const { whisperCommand, mediaPath, model, language, wordsPerLine } = params;
  const startedAt : number = Date.now();
  const outDir : string = join(process.cwd(), 'data', 'whisper-output', `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`);
  await mkdir(outDir, { recursive: true });

  const args : string[] = [
    mediaPath,
    '--model',
    model,
    '--output_format',
    'srt',
    '--output_dir',
    outDir,
    '--word_timestamps',
    'True',
    '--max_words_per_line',
    String(wordsPerLine),
  ];

  if (language.trim().toLowerCase() !== 'auto') {
    args.push('--language', language);
  }

  workerLog(`Whisper futtatás indul. mediaPath="${mediaPath}", model=${model}, language=${language}, wordsPerLine=${wordsPerLine}`);
  const output : { stdout : string; stderr : string } = await execSpawn(whisperCommand, args);
  const expectedSrtPath : string = join(outDir, `${basename(mediaPath, extname(mediaPath))}.srt`);

  let transcript : string = '';
  try {
    transcript = await readFile(expectedSrtPath, 'utf8');
  } catch {
    const stdoutTrimmed : string = output.stdout.trim();
    const stderrTrimmed : string = output.stderr.trim();
    transcript =
      extractSrtLikeText(output.stdout) ??
      extractSrtLikeText(output.stderr) ??
      (stdoutTrimmed.length > 0 ? stdoutTrimmed : null) ??
      (stderrTrimmed.length > 0 ? stderrTrimmed : null) ??
      '';
  }

  if (transcript.trim().length === 0) {
    throw new Error(`A whisper nem adott értelmezhető SRT kimenetet. stdout/stderr: ${output.stdout}\n${output.stderr}`);
  }

  workerLog(`Whisper futtatás kész. mediaPath="${mediaPath}", transcriptChars=${transcript.length}, elapsedMs=${Date.now() - startedAt}`);

  return {
    transcript,
    log: `${output.stdout}\n${output.stderr}`,
  };
}

/**
 * Folyamat futtatás és stdout/stderr összegyűjtése.
 */
async function execSpawn(command : string, args : string[]) : Promise<{ stdout : string; stderr : string }> {
  return await new Promise<{ stdout : string; stderr : string }>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout : string = '';
    let stderr : string = '';

    child.stdout.on('data', (chunk : Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk : Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error : Error) => {
      reject(error);
    });

    child.on('close', (code : number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Whisper parancs sikertelen (code=${String(code)}). command=${command} args=${args.join(' ')} stderr: ${stderr}`));
    });
  });
}

/**
 * Kinyer egy SRT-szerű blokkot a kimenetből fallbackként.
 */
function extractSrtLikeText(text : string) : string | null {
  const trimmed : string = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Hiba után visszaállítja a legrégebbi pending rekordot idle állapotba,
 * hogy ne maradjon bent végtelenül.
 */
async function recoverStuckPendingVideo(
  videosRepository : Repository<VideoEntity>,
  sqliteBusyRetryConfig : SqliteBusyRetryConfig,
) : Promise<void> {
  const stuck : VideoEntity | null = await executeWithSqliteBusyRetry(
    'pending whisper recovery lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoEntity | null> => await videosRepository.findOne({
      where: {
        processingStatus: 'pending',
        listenRequested: true,
      },
      order: {
        updatedAt: 'ASC',
        id: 'ASC',
      },
    }),
  );

  if (stuck === null) {
    return;
  }

  stuck.processingStatus = 'idle';
  stuck.listenRequested = false;
  await executeWithSqliteBusyRetry(
    'pending whisper recovery mentés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoEntity> => await videosRepository.save(stuck),
  );
}

/**
 * Worker induláskor a korábban beragadt `pending` rekordokat visszateszi `queued` állapotba,
 * hogy backend restart után újra feldolgozásra kerüljenek.
 */
async function requeuePendingVideosOnStartup(
  videosRepository : Repository<VideoEntity>,
  sqliteBusyRetryConfig : SqliteBusyRetryConfig,
) : Promise<void> {
  const pendingVideos : VideoEntity[] = await executeWithSqliteBusyRetry(
    'startup pending whisper lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoEntity[]> => await videosRepository.find({
      where: {
        processingStatus: 'pending',
        listenRequested: true,
      },
      order: {
        updatedAt: 'ASC',
        id: 'ASC',
      },
    }),
  );

  if (pendingVideos.length === 0) {
    return;
  }

  for (const video of pendingVideos) {
    video.processingStatus = 'queued';
  }
  await executeWithSqliteBusyRetry(
    'startup pending whisper mentés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoEntity[]> => await videosRepository.save(pendingVideos),
  );
  workerWarn(`${pendingVideos.length} db beragadt pending videó visszatéve queued állapotba.`);
}

/**
 * Worker induláskor a korábban megszakadt highlight feldolgozásokat visszateszi queued állapotba.
 */
async function requeueProcessingHighlightAnalysesOnStartup(
  analysesRepository : Repository<VideoHighlightAnalysisEntity>,
  sqliteBusyRetryConfig : SqliteBusyRetryConfig,
) : Promise<void> {
  const processingAnalyses : VideoHighlightAnalysisEntity[] = await executeWithSqliteBusyRetry(
    'startup processing highlight lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity[]> => await analysesRepository.find({
      where: {
        status: 'processing',
      },
      order: {
        updatedAt: 'ASC',
        id: 'ASC',
      },
    }),
  );

  if (processingAnalyses.length === 0) {
    return;
  }

  for (const analysis of processingAnalyses) {
    analysis.status = 'queued';
    analysis.stageCode = 'queued';
    analysis.stageMessage = 'Újra várólistára helyezve backend újraindítás után.';
    analysis.progressPercent = Math.min(99, Math.max(0, analysis.progressPercent));
  }

  await executeWithSqliteBusyRetry(
    'startup processing highlight mentés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity[]> => await analysesRepository.save(processingAnalyses),
  );
  workerWarn(`${processingAnalyses.length} db beragadt highlight elemzés visszatéve queued állapotba.`);
}

/**
 * Hiba után visszaállítja a legrégebbi processing highlight rekordot failed állapotra.
 */
async function recoverStuckHighlightAnalysis(
  analysesRepository : Repository<VideoHighlightAnalysisEntity>,
  sqliteBusyRetryConfig : SqliteBusyRetryConfig,
) : Promise<void> {
  const stuck : VideoHighlightAnalysisEntity | null = await executeWithSqliteBusyRetry(
    'processing highlight recovery lekérdezés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity | null> => await analysesRepository.findOne({
      where: {
        status: 'processing',
      },
      order: {
        updatedAt: 'ASC',
        id: 'ASC',
      },
    }),
  );

  if (stuck === null) {
    return;
  }

  stuck.status = 'failed';
  stuck.stageCode = 'failed';
  stuck.stageMessage = 'Feldolgozás megszakadt, újraindítható.';
  stuck.errorMessage = stuck.errorMessage.length > 0 ? stuck.errorMessage : 'Nem kezelt worker hiba.';
  stuck.completedAt = new Date();
  stuck.progressPercent = 100;
  await executeWithSqliteBusyRetry(
    'processing highlight recovery mentés',
    sqliteBusyRetryConfig,
    async () : Promise<VideoHighlightAnalysisEntity> => await analysesRepository.save(stuck),
  );
}

function delay(ms : number) : Promise<void> {
  return new Promise<void>((resolve : () => void) => {
    setTimeout(resolve, ms);
  });
}

function isSqliteBusyError(error : unknown) : boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const errorObject : Record<string, unknown> = error as Record<string, unknown>;
  const directCode : unknown = errorObject['code'];
  if (directCode === 'SQLITE_BUSY') {
    return true;
  }

  const directMessage : unknown = errorObject['message'];
  if (typeof directMessage === 'string' && directMessage.includes('SQLITE_BUSY')) {
    return true;
  }

  const driverError : unknown = errorObject['driverError'];
  if (typeof driverError === 'object' && driverError !== null) {
    const nestedCode : unknown = (driverError as Record<string, unknown>)['code'];
    if (nestedCode === 'SQLITE_BUSY') {
      return true;
    }
    const nestedMessage : unknown = (driverError as Record<string, unknown>)['message'];
    if (typeof nestedMessage === 'string' && nestedMessage.includes('SQLITE_BUSY')) {
      return true;
    }
  }

  return false;
}

async function executeWithSqliteBusyRetry<T>(
  operationName : string,
  config : SqliteBusyRetryConfig,
  operation : () => Promise<T>,
) : Promise<T> {
  let attempt : number = 1;
  while (true) {
    try {
      return await operation();
    } catch (error : unknown) {
      if (isSqliteBusyError(error) === false || attempt >= config.attempts) {
        throw error;
      }
      workerWarn(
        `SQLite lock (${operationName}), újrapróba ${attempt}/${config.attempts - 1} ${config.delayMs}ms múlva.`,
      );
      attempt += 1;
      await delay(config.delayMs);
    }
  }
}

/**
 * Whisper kimenet normalizálása:
 * - feliratsorok végéről az összes írásjel eltávolítása
 * - új sorok kezdőbetűje kisbetűsítve
 * (időbélyeg és sorszám sorok érintetlenek maradnak)
 */
function normalizeTranscriptText(transcript : string) : string {
  const lines : string[] = transcript.replace(/\r\n/g, '\n').split('\n');
  const normalizedLines : string[] = lines.map((rawLine : string) => {
    const line : string = rawLine;
    const trimmed : string = line.trim();
    if (trimmed.length === 0) {
      return line;
    }
    if (/^\d+$/.test(trimmed) || /^\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(trimmed)) {
      return line;
    }

    const withoutTrailingPunctuation : string = removeTrailingLinePunctuation(line);
    return lowercaseFirstLetter(withoutTrailingPunctuation);
  });

  return normalizedLines.join('\n');
}

/**
 * Levágja a sor végéről a whitespace utáni írásjeleket/szimbólumokat.
 */
function removeTrailingLinePunctuation(input : string) : string {
  const trimmedRight : string = input.replace(/\s+$/u, '');
  return trimmedRight.replace(/[\p{P}\p{S}]+$/gu, '');
}

/**
 * A sor első betűjét kisbetűsíti (vezető írásjelek figyelmen kívül hagyásával).
 */
function lowercaseFirstLetter(input : string) : string {
  const match : RegExpMatchArray | null = input.match(/^(\s*["'“(\[]*)([A-ZÁÉÍÓÖŐÚÜŰ])/u);
  if (match === null) {
    return input;
  }
  return `${match[1]}${match[2].toLowerCase()}${input.slice(match[0].length)}`;
}

/**
 * Whisper parancs feloldása konfigurációból.
 * 1) WHISPER_COMMAND
 * 2) /home/winben/whisper/.venv/bin/whisper
 * 3) whisper (PATH)
 */
async function resolveWhisperCommand(configService : ConfigService) : Promise<string> {
  const fromConfig : string = (configService.get<string>('WHISPER_COMMAND') ?? process.env.WHISPER_COMMAND ?? '').trim();
  if (fromConfig.length > 0) {
    const looksLikePath : boolean = fromConfig.includes('/');
    if (looksLikePath === false) {
      workerLog(`WHISPER_COMMAND névként megadva: "${fromConfig}" (PATH alapján próbálva).`);
      return fromConfig;
    }

    const existsFromConfig : boolean = await isExecutable(fromConfig);
    if (existsFromConfig === true) {
      workerLog(`WHISPER_COMMAND fájl megtalálva: ${fromConfig}`);
      return fromConfig;
    }

    workerWarn(`WHISPER_COMMAND fájl nem található vagy nem futtatható: ${fromConfig}. Fallback keresés indul.`);
  }

  const localCandidate : string = '/home/winben/whisper/.venv/bin/whisper';
  const existsLocalCandidate : boolean = await isExecutable(localCandidate);
  if (existsLocalCandidate === true) {
    workerLog(`Whisper fallback fájl megtalálva: ${localCandidate}`);
    return localCandidate;
  }

  const pathCommandAvailable : boolean = await isCommandOnPath('whisper');
  if (pathCommandAvailable === true) {
    workerLog('Whisper parancs megtalálva a PATH-ban: whisper');
    return 'whisper';
  }

  throw new Error(
    'Nem található futtatható Whisper parancs. Ellenőrizd a WHISPER_COMMAND értékét, vagy futtasd: ./scripts/install-highlight-runtime.sh',
  );
}

/**
 * Highlight AI python parancs feloldása.
 * Preferencia:
 * 1) HIGHLIGHT_AI_PYTHON_COMMAND (ha abszolút út és futtatható)
 * 2) Whisper parancs melletti venv python (ha elérhető)
 * 3) HIGHLIGHT_AI_PYTHON_COMMAND névként (PATH)
 * 4) /home/winben/whisper/.venv/bin/python
 * 5) python3 (PATH)
 */
async function resolveHighlightAiPythonCommand(configService : ConfigService, whisperCommand : string) : Promise<string> {
  const rawFromConfig : string = (
    configService.get<string>('HIGHLIGHT_AI_PYTHON_COMMAND') ?? process.env.HIGHLIGHT_AI_PYTHON_COMMAND ?? ''
  ).trim();

  if (rawFromConfig.length > 0 && rawFromConfig.includes('/')) {
    const existsFromConfig : boolean = await isExecutable(rawFromConfig);
    if (existsFromConfig === true) {
      workerLog(`Highlight AI python (config path): ${rawFromConfig}`);
      return rawFromConfig;
    }
    workerWarn(`HIGHLIGHT_AI_PYTHON_COMMAND path nem futtatható: ${rawFromConfig}. Fallback keresés indul.`);
  }

  if (whisperCommand.includes('/')) {
    const whisperSiblingPython : string = join(dirname(whisperCommand), 'python');
    const siblingExists : boolean = await isExecutable(whisperSiblingPython);
    if (siblingExists === true) {
      workerLog(`Highlight AI python a Whisper venvből: ${whisperSiblingPython}`);
      return whisperSiblingPython;
    }
  }

  if (rawFromConfig.length > 0 && rawFromConfig.includes('/') === false) {
    const commandOnPath : boolean = await isCommandOnPath(rawFromConfig);
    if (commandOnPath === true) {
      workerLog(`Highlight AI python (config name, PATH): ${rawFromConfig}`);
      return rawFromConfig;
    }
    workerWarn(`HIGHLIGHT_AI_PYTHON_COMMAND nincs a PATH-ban: ${rawFromConfig}. Fallback keresés indul.`);
  }

  const localCandidate : string = '/home/winben/whisper/.venv/bin/python';
  const existsLocalCandidate : boolean = await isExecutable(localCandidate);
  if (existsLocalCandidate === true) {
    workerLog(`Highlight AI python fallback fájl megtalálva: ${localCandidate}`);
    return localCandidate;
  }

  const python3OnPath : boolean = await isCommandOnPath('python3');
  if (python3OnPath === true) {
    workerLog('Highlight AI python fallback a PATH-ból: python3');
    return 'python3';
  }

  workerWarn('Nem található dedikált Highlight AI python. Alapértelmezett python3 parancs lesz használva.');
  return DEFAULT_HIGHLIGHT_AI_PYTHON_COMMAND;
}

/**
 * Ellenőrzi, hogy a parancs elérhető-e a PATH-ban.
 */
async function isCommandOnPath(command : string) : Promise<boolean> {
  return await new Promise<boolean>((resolve : (value : boolean) => void) => {
    execFile('bash', ['-lc', `command -v ${command}`], (error : Error | null, stdout : string) => {
      if (error !== null) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

/**
 * Ellenőrzi, hogy az útvonal végrehajtható fájl-e.
 */
async function isExecutable(path : string) : Promise<boolean> {
  return await new Promise<boolean>((resolve : (value : boolean) => void) => {
    access(path, constants.X_OK, (error : NodeJS.ErrnoException | null) => {
      resolve(error === null);
    });
  });
}
