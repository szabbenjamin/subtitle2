import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { resolveUploadsDir } from './common/utils/uploads-dir.util';

/**
 * Elindítja a NestJS alkalmazást a szükséges middleware-ekkel.
 */
async function bootstrap() : Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors({
    origin: true,
    credentials: true,
  });
  const uploadsDir : string = resolveUploadsDir(process.env.UPLOADS_DIR);
  app.useStaticAssets(uploadsDir, {
    prefix: '/api/uploads/',
  });
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  const port : number = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
