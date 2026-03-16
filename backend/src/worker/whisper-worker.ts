import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { basename, extname, join } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { access, constants } from 'fs';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { VideoEntity } from '../videos/entities/video.entity';

interface WhisperResult {
  transcript : string;
  log : string;
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
  const uploadsDir : string = resolveUploadsDir(configService.get<string>('UPLOADS_DIR'));
  const pollMs : number = Number(configService.get<string>('WHISPER_QUEUE_POLL_MS') ?? '2500');
  const whisperCommand : string = await resolveWhisperCommand(configService);
  let stopRequested : boolean = false;
  const requestStop = () : void => {
    stopRequested = true;
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  process.on('disconnect', requestStop);
  console.log(`[WhisperWorker] Használt parancs: ${whisperCommand}`);
  await requeuePendingVideosOnStartup(videosRepository);

  // Egyszerre egy feladatot futtatunk, FIFO jelleggel.
  // Több worker process esetén külön lockolás szükséges.
  while (stopRequested === false) {
    try {
      const queuedVideo : VideoEntity | null = await videosRepository.findOne({
        where: {
          listenRequested: true,
          processingStatus: 'queued',
        },
        order: {
          updatedAt: 'ASC',
          id: 'ASC',
        },
      });

      if (queuedVideo === null) {
        await delay(pollMs);
        continue;
      }

      queuedVideo.processingStatus = 'pending';
      await videosRepository.save(queuedVideo);

      const mediaPath : string = join(uploadsDir, queuedVideo.storageFileName);
      const whisperResult : WhisperResult = await runWhisperForVideo({
        whisperCommand,
        mediaPath,
        model: queuedVideo.whisperModel,
        language: queuedVideo.whisperLanguage,
        wordsPerLine: queuedVideo.wordsPerLine,
      });

      queuedVideo.subtitleText = normalizeTranscriptText(whisperResult.transcript);
      queuedVideo.processingStatus = 'idle';
      queuedVideo.listenRequested = false;
      await videosRepository.save(queuedVideo);
    } catch (error : unknown) {
      console.error('[WhisperWorker] Feldolgozási hiba:', error);

      // Hiba esetén ne maradjon beragadva pending állapotban.
      await recoverStuckPendingVideo(videosRepository);
      await delay(Math.max(1000, pollMs));
    }
  }

  await appContext.close();
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

  console.log(`[WhisperWorker] Futtatás: ${whisperCommand} ${args.join(' ')}`);
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
async function recoverStuckPendingVideo(videosRepository : Repository<VideoEntity>) : Promise<void> {
  const stuck : VideoEntity | null = await videosRepository.findOne({
    where: {
      processingStatus: 'pending',
      listenRequested: true,
    },
    order: {
      updatedAt: 'ASC',
      id: 'ASC',
    },
  });

  if (stuck === null) {
    return;
  }

  stuck.processingStatus = 'idle';
  stuck.listenRequested = false;
  await videosRepository.save(stuck);
}

/**
 * Worker induláskor a korábban beragadt `pending` rekordokat visszateszi `queued` állapotba,
 * hogy backend restart után újra feldolgozásra kerüljenek.
 */
async function requeuePendingVideosOnStartup(videosRepository : Repository<VideoEntity>) : Promise<void> {
  const pendingVideos : VideoEntity[] = await videosRepository.find({
    where: {
      processingStatus: 'pending',
      listenRequested: true,
    },
    order: {
      updatedAt: 'ASC',
      id: 'ASC',
    },
  });

  if (pendingVideos.length === 0) {
    return;
  }

  for (const video of pendingVideos) {
    video.processingStatus = 'queued';
  }
  await videosRepository.save(pendingVideos);
  console.log(`[WhisperWorker] ${pendingVideos.length} db beragadt pending videó visszatéve queued állapotba.`);
}

function delay(ms : number) : Promise<void> {
  return new Promise<void>((resolve : () => void) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whisper kimenet normalizálása:
 * - feliratsorok végéről pont eltávolítása
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

    const withoutTrailingDot : string = line.replace(/\.\s*$/, '');
    return lowercaseFirstLetter(withoutTrailingDot);
  });

  return normalizedLines.join('\n');
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
    return fromConfig;
  }

  const localCandidate : string = '/home/winben/whisper/.venv/bin/whisper';
  const exists : boolean = await isExecutable(localCandidate);
  if (exists === true) {
    return localCandidate;
  }

  return 'whisper';
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
