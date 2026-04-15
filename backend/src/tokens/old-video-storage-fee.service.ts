import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThanOrEqual, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { UserEntity } from '../users/entities/user.entity';
import { VideoEntity } from '../videos/entities/video.entity';
import {
  TOKEN_COST_OLD_VIDEO_STORAGE_DAILY,
  TOKEN_ENTRY_TYPE_OLD_VIDEO_STORAGE,
} from './tokens.constants';
import { TokenHistoryEntity } from './entities/token-history.entity';
import { TokensService } from './tokens.service';

const OLD_VIDEO_THRESHOLD_DAYS : number = 30;
const DAILY_RUN_HOUR : number = 16;
const CHECK_INTERVAL_MS : number = 60_000;

@Injectable()
export class OldVideoStorageFeeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger : Logger = new Logger(OldVideoStorageFeeService.name);
  private timer ?: ReturnType<typeof setInterval>;
  private lastRunDateKey : string = '';
  private isRunInProgress : boolean = false;

  public constructor(
    @InjectRepository(VideoEntity)
    private readonly videosRepository : Repository<VideoEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepository : Repository<UserEntity>,
    @InjectRepository(TokenHistoryEntity)
    private readonly tokenHistoryRepository : Repository<TokenHistoryEntity>,
    private readonly tokensService : TokensService,
    private readonly mailService : MailService,
  ) {}

  public onModuleInit() : void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (process.env.WHISPER_WORKER_CHILD === '1') {
      this.logger.log('Régi videó tárolási díj scheduler kihagyva worker child processben.');
      return;
    }

    this.timer = setInterval(() => {
      void this.tryRunDailyStorageFee();
    }, CHECK_INTERVAL_MS);

    void this.tryRunDailyStorageFee();
  }

  public onModuleDestroy() : void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tryRunDailyStorageFee() : Promise<void> {
    if (this.isRunInProgress === true) {
      return;
    }

    const now : Date = new Date();
    if (now.getHours() < DAILY_RUN_HOUR) {
      return;
    }

    const todayKey : string = this.toLocalDateKey(now);
    if (this.lastRunDateKey === todayKey) {
      return;
    }

    this.isRunInProgress = true;
    try {
      await this.processDailyStorageFee(now);
      this.lastRunDateKey = todayKey;
    } catch (error : unknown) {
      const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
      this.logger.error(`Napi régi videó díj futás hiba: ${details}`, error instanceof Error ? error.stack : undefined);
    } finally {
      this.isRunInProgress = false;
    }
  }

  private async processDailyStorageFee(now : Date) : Promise<void> {
    const cutoffDate : Date = new Date(now.getTime() - OLD_VIDEO_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const oldVideos : VideoEntity[] = await this.videosRepository.find({
      where: {
        createdAt: LessThanOrEqual(cutoffDate),
      },
      order: {
        ownerId: 'ASC',
        createdAt: 'ASC',
        id: 'ASC',
      },
    });

    if (oldVideos.length === 0) {
      this.logger.log('Napi régi videó díj futás: nincs 1 hónapnál régebbi videó.');
      return;
    }

    const startOfDay : Date = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay : Date = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const videosByOwner : Map<number, VideoEntity[]> = new Map<number, VideoEntity[]>();
    for (const video of oldVideos) {
      const current : VideoEntity[] = videosByOwner.get(video.ownerId) ?? [];
      current.push(video);
      videosByOwner.set(video.ownerId, current);
    }

    for (const [ownerId, videos] of videosByOwner.entries()) {
      const user : UserEntity | null = await this.usersRepository.findOne({
        where: { id: ownerId },
      });
      if (user === null) {
        continue;
      }

      const alreadyChargedVideoIds : Set<number> = await this.readAlreadyChargedVideoIdsForToday(ownerId, startOfDay, endOfDay);
      let chargedToday : number = 0;
      let unchargedToday : number = 0;

      for (let index : number = 0; index < videos.length; index += 1) {
        const video : VideoEntity = videos[index];
        if (alreadyChargedVideoIds.has(video.id) === true) {
          continue;
        }

        try {
          await this.tokensService.charge(
            ownerId,
            TOKEN_COST_OLD_VIDEO_STORAGE_DAILY,
            TOKEN_ENTRY_TYPE_OLD_VIDEO_STORAGE,
            this.buildStorageFeeDescription(video),
          );
          chargedToday += TOKEN_COST_OLD_VIDEO_STORAGE_DAILY;
        } catch (error : unknown) {
          const details : string = error instanceof Error ? error.message : 'ismeretlen hiba';
          this.logger.warn(
            `Régi videó napi díj sikertelen. ownerId=${ownerId}, videoId=${video.id}, details=${details}`,
          );

          // Ha elfogy a token, a fennmaradó videókra sem fog tudni levonni.
          for (let restIndex : number = index; restIndex < videos.length; restIndex += 1) {
            const restVideo : VideoEntity = videos[restIndex];
            if (alreadyChargedVideoIds.has(restVideo.id) === false) {
              unchargedToday += 1;
            }
          }
          break;
        }
      }

      await this.mailService.sendOldVideoStorageReminderEmail({
        email: user.email,
        oldVideoCount: videos.length,
        chargedToday,
        unchargedToday,
      });

      this.logger.log(
        `Régi videó napi díj kész. ownerId=${ownerId}, oldVideos=${videos.length}, chargedToday=${chargedToday}, unchargedToday=${unchargedToday}`,
      );
    }
  }

  private async readAlreadyChargedVideoIdsForToday(ownerId : number, startOfDay : Date, endOfDay : Date) : Promise<Set<number>> {
    const entries : TokenHistoryEntity[] = await this.tokenHistoryRepository.find({
      where: {
        userId: ownerId,
        type: TOKEN_ENTRY_TYPE_OLD_VIDEO_STORAGE,
        createdAt: Between(startOfDay, endOfDay),
      },
      order: {
        createdAt: 'ASC',
      },
    });

    const chargedVideoIds : Set<number> = new Set<number>();
    for (const entry of entries) {
      const parsedVideoId : number | null = this.extractVideoIdFromDescription(entry.description);
      if (parsedVideoId !== null) {
        chargedVideoIds.add(parsedVideoId);
      }
    }
    return chargedVideoIds;
  }

  private buildStorageFeeDescription(video : VideoEntity) : string {
    return `Régi videó tárolási díj (videoId=${video.id}): ${video.originalFileName}`;
  }

  private extractVideoIdFromDescription(description : string) : number | null {
    const match : RegExpMatchArray | null = description.match(/videoId=(\d+)/i);
    if (match === null) {
      return null;
    }
    const parsed : number = Number(match[1]);
    if (Number.isInteger(parsed) === false || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private toLocalDateKey(value : Date) : string {
    const year : number = value.getFullYear();
    const month : string = String(value.getMonth() + 1).padStart(2, '0');
    const day : string = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
