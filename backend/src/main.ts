import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ChildProcess, execFile, fork } from 'child_process';
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

  const port : number = Number(process.env.PORT ?? 3000);
  await forceFreePortIfConfigured(port);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  let workerChild : ChildProcess | null = null;
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

  try {
    // A ConfigModule ekkorra már betöltötte a .env-t, így a child worker örökli
    // a WHISPER_COMMAND/egyéb környezeti változókat is.
    workerChild = spawnWhisperWorkerChild();
    registerShutdownHandlers(workerChild);

    await app.listen(port);
  } catch (error : unknown) {
    terminateWorker(workerChild);
    throw error;
  }
}

void bootstrap();

/**
 * Elindít egy külön Node child processzt a whisper queue workerhez.
 */
function spawnWhisperWorkerChild() : ChildProcess | null {
  if (process.env.WHISPER_WORKER_AUTOSTART === 'false') {
    console.log('[WhisperWorker] Autostart letiltva (WHISPER_WORKER_AUTOSTART=false).');
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
    terminateWorker(workerChild);
  };

  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  process.on('exit', terminate);
}

/**
 * Worker child leállítása, ha fut.
 */
function terminateWorker(workerChild : ChildProcess | null) : void {
  if (workerChild === null || workerChild.killed === true) {
    return;
  }
  workerChild.kill('SIGTERM');
}

/**
 * Indulás előtt felszabadítja a portot, ha konfiguráció engedi.
 * Alapértelmezés: engedélyezett (`FORCE_FREE_PORT_ON_START` != `false`).
 */
async function forceFreePortIfConfigured(port : number) : Promise<void> {
  if (process.env.FORCE_FREE_PORT_ON_START === 'false') {
    return;
  }
  const listeningPids : number[] = await findListeningPids(port);
  if (listeningPids.length === 0) {
    return;
  }

  for (const pid of listeningPids) {
    if (pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignoráljuk, ha közben már leállt.
    }
  }

  await wait(450);

  const remainedPids : number[] = await findListeningPids(port);
  for (const pid of remainedPids) {
    if (pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignoráljuk, ha már nem él a process.
    }
  }
}

/**
 * Lekéri az adott porton LISTEN állapotban lévő PID-eket.
 */
async function findListeningPids(port : number) : Promise<number[]> {
  const output : string = await new Promise<string>((resolve : (value : string) => void) => {
    execFile('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'], (error : Error | null, stdout : string) => {
      if (error !== null) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
  });

  return output
    .split('\n')
    .map((line : string) => Number(line.trim()))
    .filter((pid : number) => Number.isInteger(pid) && pid > 0);
}

function wait(ms : number) : Promise<void> {
  return new Promise<void>((resolve : () => void) => {
    setTimeout(resolve, ms);
  });
}
