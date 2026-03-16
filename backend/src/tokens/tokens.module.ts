import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserEntity } from '../users/entities/user.entity';
import { TokenHistoryEntity } from './entities/token-history.entity';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([UserEntity, TokenHistoryEntity]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService : ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? 'change-me-in-production',
      }),
    }),
  ],
  providers: [TokensService, JwtAuthGuard],
  controllers: [TokensController],
  exports: [TokensService],
})
export class TokensModule {}
