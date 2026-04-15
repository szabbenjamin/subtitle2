import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { existsSync } from 'fs';
import { AuthModule } from './auth/auth.module';
import { SubtitlePresetsModule } from './subtitle-presets/subtitle-presets.module';
import { SubtitlePresetEntity } from './subtitle-presets/entities/subtitle-preset.entity';
import { TokenHistoryEntity } from './tokens/entities/token-history.entity';
import { TokensModule } from './tokens/tokens.module';
import { UserEntity } from './users/entities/user.entity';
import { VideoHighlightAnalysisEntity } from './videos/entities/video-highlight-analysis.entity';
import { VideoHighlightClipEntity } from './videos/entities/video-highlight-clip.entity';
import { VideoEntity } from './videos/entities/video.entity';
import { VideosModule } from './videos/videos.module';

function readPositiveIntegerConfig(configService : ConfigService, key : string, fallback : number) : number {
  const raw : string = (configService.get<string>(key) ?? '').trim();
  if (raw.length === 0) {
    return fallback;
  }

  const parsed : number = Number(raw);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function readBooleanConfig(configService : ConfigService, key : string, fallback : boolean) : boolean {
  const raw : string = (configService.get<string>(key) ?? '').trim().toLowerCase();
  if (raw.length === 0) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }
  return fallback;
}

function readTextConfig(configService : ConfigService, key : string, fallback : string) : string {
  const raw : string = (configService.get<string>(key) ?? '').trim();
  return raw.length > 0 ? raw : fallback;
}

function readEnvText(env : Record<string, unknown>, key : string) : string {
  const raw : string = String(env[key] ?? '').trim();
  return raw;
}

function isTruthyConfigValue(raw : string) : boolean {
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function isPositiveIntegerText(raw : string) : boolean {
  const parsed : number = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed);
}

function validateEnvironment(rawEnv : Record<string, unknown>) : Record<string, unknown> {
  const nodeEnv : string = readEnvText(rawEnv, 'NODE_ENV').toLowerCase();
  if (nodeEnv === 'test') {
    return rawEnv;
  }

  const requiredKeys : string[] = [
    'JWT_SECRET',
    'FRONTEND_BASE_URL',
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_PASSWORD',
    'MYSQL_DATABASE',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'WHISPER_COMMAND',
    'YTDLP_COMMAND',
    'OPENAI_API_KEY',
  ];
  const missing : string[] = [];
  for (const key of requiredKeys) {
    if (readEnvText(rawEnv, key).length === 0) {
      missing.push(key);
    }
  }

  const invalid : string[] = [];
  const positiveIntegerKeys : string[] = [
    'MYSQL_PORT',
    'WHISPER_QUEUE_POLL_MS',
    'DB_BUSY_RETRY_ATTEMPTS',
    'DB_BUSY_RETRY_DELAY_MS',
    'OPENAI_TIMEOUT_MS',
  ];
  for (const key of positiveIntegerKeys) {
    const raw : string = readEnvText(rawEnv, key);
    if (raw.length === 0) {
      continue;
    }
    if (isPositiveIntegerText(raw) === false) {
      invalid.push(`${key} (pozitiv egesz szam szukseges)`);
    }
  }

  const dbSync : string = readEnvText(rawEnv, 'DB_SYNCHRONIZE');
  if (dbSync.length > 0 && ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(dbSync.toLowerCase()) === false) {
    invalid.push('DB_SYNCHRONIZE (true/false szukseges)');
  }

  const validateBinaryPath = (key : string) : void => {
    const command : string = readEnvText(rawEnv, key);
    if (command.length === 0 || command.includes('/') === false) {
      return;
    }
    if (existsSync(command) === false) {
      invalid.push(`${key} (nem letezo fajl: ${command})`);
    }
  };

  validateBinaryPath('WHISPER_COMMAND');
  validateBinaryPath('YTDLP_COMMAND');

  const highlightEnabled : boolean = isTruthyConfigValue(readEnvText(rawEnv, 'HIGHLIGHT_AI_ENABLED'));
  if (highlightEnabled) {
    const pythonCommand : string = readEnvText(rawEnv, 'HIGHLIGHT_AI_PYTHON_COMMAND');
    if (pythonCommand.length === 0) {
      missing.push('HIGHLIGHT_AI_PYTHON_COMMAND');
    } else if (pythonCommand.includes('/') && existsSync(pythonCommand) === false) {
      invalid.push(`HIGHLIGHT_AI_PYTHON_COMMAND (nem letezo fajl: ${pythonCommand})`);
    }

    const scriptPath : string = readEnvText(rawEnv, 'HIGHLIGHT_AI_SCRIPT_PATH');
    if (scriptPath.length === 0) {
      missing.push('HIGHLIGHT_AI_SCRIPT_PATH');
    } else if (scriptPath.includes('/') && existsSync(scriptPath) === false) {
      invalid.push(`HIGHLIGHT_AI_SCRIPT_PATH (nem letezo fajl: ${scriptPath})`);
    }
  }

  if (missing.length === 0 && invalid.length === 0) {
    return rawEnv;
  }

  const sections : string[] = [];
  if (missing.length > 0) {
    sections.push(`Hianyzo env valtozok: ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    sections.push(`Ervenytelen env ertekek: ${invalid.join(', ')}`);
  }
  sections.push('Docker futas: docker compose up --build (ellenorizd, hogy .env -> .env.docker symlink letezik)');

  throw new Error(`[ConfigValidation] ${sections.join(' | ')}`);
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService : ConfigService) => ({
        type: 'mysql' as const,
        host: readTextConfig(configService, 'MYSQL_HOST', '127.0.0.1'),
        port: readPositiveIntegerConfig(configService, 'MYSQL_PORT', 3306),
        username: readTextConfig(configService, 'MYSQL_USER', 'subtitle2'),
        password: configService.get<string>('MYSQL_PASSWORD') ?? '',
        database: readTextConfig(configService, 'MYSQL_DATABASE', 'subtitle2'),
        charset: readTextConfig(configService, 'MYSQL_CHARSET', 'utf8mb4'),
        timezone: readTextConfig(configService, 'MYSQL_TIMEZONE', 'Z'),
        entities: [UserEntity, VideoEntity, VideoHighlightAnalysisEntity, VideoHighlightClipEntity, SubtitlePresetEntity, TokenHistoryEntity],
        synchronize: readBooleanConfig(configService, 'DB_SYNCHRONIZE', true),
      }),
    }),
    AuthModule,
    SubtitlePresetsModule,
    TokensModule,
    VideosModule,
  ],
})
export class AppModule {}
