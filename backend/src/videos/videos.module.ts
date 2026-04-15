import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import { TokensModule } from '../tokens/tokens.module';
import { UserEntity } from '../users/entities/user.entity';
import { VideoHighlightAnalysisEntity } from './entities/video-highlight-analysis.entity';
import { VideoHighlightClipEntity } from './entities/video-highlight-clip.entity';
import { VideoEntity } from './entities/video.entity';
import { UploadsOrphanCleanupService } from './uploads-orphan-cleanup.service';
import { VideoExportService } from './video-export.service';
import { VideoHighlightsService } from './video-highlights.service';
import { VideoSocialService } from './video-social.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([VideoEntity, VideoHighlightAnalysisEntity, VideoHighlightClipEntity, SubtitlePresetEntity, UserEntity]), AuthModule, TokensModule],
  providers: [VideosService, VideoExportService, VideoSocialService, VideoHighlightsService, UploadsOrphanCleanupService],
  controllers: [VideosController],
})
export class VideosModule {}
