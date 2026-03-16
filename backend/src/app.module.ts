import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { SubtitlePresetsModule } from './subtitle-presets/subtitle-presets.module';
import { SubtitlePresetEntity } from './subtitle-presets/entities/subtitle-preset.entity';
import { TokenHistoryEntity } from './tokens/entities/token-history.entity';
import { TokensModule } from './tokens/tokens.module';
import { UserEntity } from './users/entities/user.entity';
import { VideoEntity } from './videos/entities/video.entity';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService : ConfigService) => ({
        type: 'sqlite',
        database: configService.get<string>('SQLITE_PATH') ?? 'data/subtitle2.sqlite',
        entities: [UserEntity, VideoEntity, SubtitlePresetEntity, TokenHistoryEntity],
        synchronize: true,
      }),
    }),
    AuthModule,
    SubtitlePresetsModule,
    TokensModule,
    VideosModule,
  ],
})
export class AppModule {}
