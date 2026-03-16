import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SubtitlePresetEntity } from './entities/subtitle-preset.entity';
import { SubtitlePresetsController } from './subtitle-presets.controller';
import { SubtitlePresetsService } from './subtitle-presets.service';

@Module({
  imports: [TypeOrmModule.forFeature([SubtitlePresetEntity]), AuthModule],
  providers: [SubtitlePresetsService],
  controllers: [SubtitlePresetsController],
  exports: [TypeOrmModule, SubtitlePresetsService],
})
export class SubtitlePresetsModule {}
