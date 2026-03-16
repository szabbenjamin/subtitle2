import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import { VideoEntity } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([VideoEntity, SubtitlePresetEntity]), AuthModule],
  providers: [VideosService],
  controllers: [VideosController],
})
export class VideosModule {}
