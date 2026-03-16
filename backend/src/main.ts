import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ChildProcess, fork } from 'child_process';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { resolveUploadsDir } from './common/utils/uploads-dir.util';
import { runWhisperWorkerProcess } from './worker/whisper-worker';

/**
 * Elindítja a NestJS alkalmazást a szükséges middleware-ekkel.
 */
async function bootstrap() : Promise<void> {
  if (process.env.WHISPER_WORKER_CHILD === '1') {
    await runWhisperWorkerProcess();
    return;
  }

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

  // A ConfigModule ekkorra már betöltötte a .env-t, így a child worker örökli
  // a WHISPER_COMMAND/egyéb környezeti változókat is.
  const workerChild : ChildProcess | null = spawnWhisperWorkerChild();

  const port : number = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  registerShutdownHandlers(workerChild);
}

void bootstrap();

/**
 * Elindít egy külön Node child processzt a whisper queue workerhez.
 */
function spawnWhisperWorkerChild() : ChildProcess | null {
  if (process.env.WHISPER_WORKER_AUTOSTART === 'false') {
    return null;
  }
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  const worker : ChildProcess = fork(__filename, [], {
    // Mindig a jelenlegi main modult indítjuk újra worker módban.
    // `process.argv[1]` dev/watch alatt lehet a Nest CLI, ami hibásan egy második HTTP appot indíthat.
    execArgv: process.execArgv,
    env: {
      ...process.env,
      WHISPER_WORKER_CHILD: '1',
      WHISPER_WORKER_AUTOSTART: 'false',
    },
    stdio: 'inherit',
  });

  return worker;
}

/**
 * Leállításkor bezárja a child processzt, hogy ne maradjon árva worker.
 */
function registerShutdownHandlers(workerChild : ChildProcess | null) : void {
  const terminate = () : void => {
    if (workerChild === null || workerChild.killed === true) {
      return;
    }
    workerChild.kill('SIGTERM');
  };

  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  process.on('exit', terminate);
}
