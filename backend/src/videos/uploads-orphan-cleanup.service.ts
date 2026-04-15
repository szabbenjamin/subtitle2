import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { mkdir, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { Repository } from 'typeorm';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { VideoHighlightClipEntity } from './entities/video-highlight-clip.entity';
import { VideoEntity } from './entities/video.entity';

const DEFAULT_SWEEP_INTERVAL_MS : number = 60 * 60 * 1000;
const DEFAULT_MIN_ORPHAN_AGE_MINUTES : number = 6 * 60;

interface UploadFileEntry {
  absolutePath : string;
  relativePath : string;
  modifiedAtMs : number;
}

@Injectable()
export class UploadsOrphanCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger : Logger = new Logger(UploadsOrphanCleanupService.name);
  private readonly uploadsDir : string;
  private readonly sweepIntervalMs : number;
  private readonly minOrphanAgeMs : number;
  private timer ?: ReturnType<typeof setInterval>;
  private sweepInProgress : boolean = false;

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    @InjectRepository(VideoHighlightClipEntity)
    private readonly clipsRepository : Repository<VideoHighlightClipEntity>,
    private readonly configService : ConfigService,
  ) {
    this.uploadsDir = resolveUploadsDir(this.configService.get<string>('UPLOADS_DIR'));
    this.sweepIntervalMs = this.readPositiveIntegerEnv('UPLOADS_ORPHAN_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
    const minAgeMinutes : number = this.readPositiveIntegerEnv('UPLOADS_ORPHAN_MIN_AGE_MINUTES', DEFAULT_MIN_ORPHAN_AGE_MINUTES);
    this.minOrphanAgeMs = minAgeMinutes * 60 * 1000;
  }

  public onModuleInit() : void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (process.env.WHISPER_WORKER_CHILD === '1') {
      this.logger.log('Orphan uploads cleanup scheduler kihagyva worker child processben.');
      return;
    }

    this.timer = setInterval(() => {
      void this.runSweep();
    }, this.sweepIntervalMs);
    void this.runSweep();
  }

  public onModuleDestroy() : void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runSweep() : Promise<void> {
    if (this.sweepInProgress === true) {
      return;
    }

    this.sweepInProgress = true;
    try {
      await mkdir(this.uploadsDir, { recursive: true });
      const [referencedPaths, uploadFiles] : [Set<string>, UploadFileEntry[]] = await Promise.all([
        this.collectReferencedUploadPaths(),
        this.collectUploadFilesRecursive(''),
      ]);

      const nowMs : number = Date.now();
      let deletedCount : number = 0;

      for (const file of uploadFiles) {
        if (referencedPaths.has(file.relativePath) === true) {
          continue;
        }
        if (nowMs - file.modifiedAtMs < this.minOrphanAgeMs) {
          continue;
        }

        await rm(file.absolutePath, { force: true });
        deletedCount += 1;
      }

      if (deletedCount > 0) {
        this.logger.warn(
          `Orphan uploads takarítás kész. scanned=${uploadFiles.length}, referenced=${referencedPaths.size}, removed=${deletedCount}`,
        );
      }
    } catch (error : unknown) {
      const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.error(`Orphan uploads takarítás hiba: ${details}`, error instanceof Error ? error.stack : undefined);
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async collectReferencedUploadPaths() : Promise<Set<string>> {
    const references : Set<string> = new Set<string>();
    const videos : Array<Pick<VideoEntity, 'storageFileName' | 'thumbnailFileName'>> = await this.videosRepository.find({
      select: {
        storageFileName: true,
        thumbnailFileName: true,
      },
    });

    for (const video of videos) {
      this.addReferenceIfPresent(references, video.storageFileName);
      this.addReferenceIfPresent(references, video.thumbnailFileName);
    }

    const clips : Array<Pick<VideoHighlightClipEntity, 'screenshotFileName'>> = await this.clipsRepository.find({
      select: {
        screenshotFileName: true,
      },
    });
    for (const clip of clips) {
      this.addReferenceIfPresent(references, clip.screenshotFileName);
    }

    return references;
  }

  private async collectUploadFilesRecursive(relativeDirectory : string) : Promise<UploadFileEntry[]> {
    const absoluteDirectory : string = relativeDirectory.length > 0
      ? join(this.uploadsDir, relativeDirectory)
      : this.uploadsDir;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const files : UploadFileEntry[] = [];

    for (const entry of entries) {
      const nextRelativePath : string = relativeDirectory.length > 0
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;

      if (entry.isDirectory() === true) {
        const nestedFiles : UploadFileEntry[] = await this.collectUploadFilesRecursive(nextRelativePath);
        files.push(...nestedFiles);
        continue;
      }
      if (entry.isFile() === false) {
        continue;
      }

      const absolutePath : string = join(this.uploadsDir, nextRelativePath);
      const fileStat = await stat(absolutePath);
      files.push({
        absolutePath,
        relativePath: this.normalizeRelativePath(nextRelativePath),
        modifiedAtMs: fileStat.mtimeMs,
      });
    }

    return files;
  }

  private addReferenceIfPresent(target : Set<string>, rawPath : string) : void {
    const normalized : string = this.normalizeRelativePath(rawPath);
    if (normalized.length === 0) {
      return;
    }
    target.add(normalized);
  }

  private normalizeRelativePath(rawPath : string) : string {
    return rawPath.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  }

  private readPositiveIntegerEnv(name : string, fallback : number) : number {
    const fromConfig : string | undefined = this.configService.get<string>(name);
    const fromEnv : string | undefined = process.env[name];
    const raw : string = (fromConfig ?? fromEnv ?? '').trim();
    if (raw.length === 0) {
      return fallback;
    }
    const parsed : number = Number(raw);
    if (Number.isFinite(parsed) === false || parsed <= 0) {
      return fallback;
    }
    return Math.round(parsed);
  }
}
