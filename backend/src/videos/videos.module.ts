import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import { TokensModule } from '../tokens/tokens.module';
import { VideoEntity } from './entities/video.entity';
import { VideoExportService } from './video-export.service';
import { VideoSocialService } from './video-social.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([VideoEntity, SubtitlePresetEntity]), AuthModule, TokensModule],
  providers: [VideosService, VideoExportService, VideoSocialService],
  controllers: [VideosController],
})
export class VideosModule {}
