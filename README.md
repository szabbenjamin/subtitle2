# subtitle2

Teljes stack projekt két mappában:
- `frontend`: Angular 21 PWA
- `backend`: NestJS 11 + MySQL

## Részletes dokumentáció

- [docs/projekt-kezikonyv.md](docs/projekt-kezikonyv.md) – teljes működésleírás (képernyő-flow, backend pipeline, tokenek, Docker, CI/CD, hibaelhárítás)

## Fejlesztői indítás

Használj két terminált: egyet backendhez, egyet frontendhez.

## Docker Compose (Teljes stack)

A projekt most futtatható egyetlen compose paranccsal (frontend + backend + MySQL + whisper/highlight runtime).
A backend image tartalmazza a `yt-dlp`, `whisper` és a lokális highlight AI futtatáshoz szükséges runtime-ot, valamint előtöltött model cache-t is.

### 1) Környezeti változók

```bash
cp .env.docker.example .env.docker
ln -sfn .env.docker .env
```

Ha kell, szerkeszd a `.env.docker` fájlt (különösen `JWT_SECRET`, `MYSQL_*`, `OPENAI_API_KEY`, `SMTP_*`).
Induláskor a backend fail-fast env validációt futtat; hiányzó vagy hibás kötelező változó esetén nem indul el.

A változékony mappák host oldali bekötése `.env`-ből állítható:
- `MYSQL_DATA_DIR`
- `BACKEND_UPLOADS_DIR`
- `BACKEND_DATA_DIR`
- `WHISPER_CACHE_DIR`

Példa:

```env
MYSQL_DATA_DIR=/srv/subtitle2/mysql
BACKEND_UPLOADS_DIR=/srv/subtitle2/uploads
BACKEND_DATA_DIR=/srv/subtitle2/data
WHISPER_CACHE_DIR=/srv/subtitle2/whisper-cache
```

### 2) Indítás

```bash
docker compose up --build
```

Első buildkor a backend image Python/Whisper/NLP csomagokat és modelleket is előkészít, ezért lassabb lehet.
Indításkor, ha a `WHISPER_CACHE_DIR` üres, a konténer automatikusan be-seedeli az előtöltött model cache-t.

### 3) Elérés

- Frontend: `http://localhost` (vagy a beállított `FRONTEND_PORT`)
- Backend API: `http://localhost:3000/api` (vagy a beállított `BACKEND_PORT`)

### 4) Leállítás

```bash
docker compose down
```

Ha a DB volume-ot is törölni akarod:

```bash
docker compose down -v
```

### Docker dev mód (auto reload)

Forrásmódosításra automatikus újrafordítás/újraindítás:
- backend: `npm run start:dev` watcher konténerben
- frontend: Angular `ng serve` konténerben

Indítás:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Leállítás:

```bash
docker compose -f docker-compose.dev.yml down
```

### Env fájlok szerepe

- `./.env.docker.example`: Docker stack mintafájl.
- `./.env.docker`: Docker stack aktív env fájl.
- `./.env`: symlink a `.env.docker`-re, hogy a `docker compose` parancs `--env-file` nélkül is ugyanazt a készletet használja.
- `./backend/.env.example`: backend lokális (nem dockeres) futtatás mintafájl.
- `./backend/.env`: backend lokális (nem dockeres) futtatás aktív env fájl.

Megjegyzés: a dockeres futtatásnál a `backend/.env` nincs használatban, ott a compose által átadott env változók érvényesülnek.
Ha kizárólag Dockerrel futtatod a rendszert, a `backend/.env` fájl gyakorlatilag elhagyható.

### Elárvult env takarítás (SQLite -> MySQL migráció után)

- A régi `SQLITE_PATH` változó már nem használt.
- Ha a `backend/.env` még tartalmazza, töröld, vagy generáld újra a fájlt a friss mintából:

```bash
cd backend
cp .env.example .env
```

### Backend dev szerver

```bash
source ~/.nvm/nvm.sh
nvm use 24

cd backend
cp .env.example .env
npm install
npm run start:dev
```

MySQL-hez szükséges, hogy létezzen a DB/user (példa):

```sql
CREATE DATABASE subtitle2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'subtitle2'@'%' IDENTIFIED BY 'eros-jelszo';
GRANT ALL PRIVILEGES ON subtitle2.* TO 'subtitle2'@'%';
FLUSH PRIVILEGES;
```

### Frontend dev szerver

Új terminálban:

```bash
source ~/.nvm/nvm.sh
nvm use 24

cd frontend
npm install
npm start
```

A frontend `ng serve --proxy-config proxy.conf.json` módban fut, így minden API hívás `/api/...` URL-en megy a backend felé.

## Unit tesztek

### Backend unit tesztek

```bash
source ~/.nvm/nvm.sh
nvm use 24
cd backend
npm test -- --runInBand
```

### Frontend unit tesztek

```bash
source ~/.nvm/nvm.sh
nvm use 24
cd frontend
npm test -- --watch=false
```

## Fő route-ok

- `/login`
- `/login/reset?resetToken=...`
- `/lista`
- `/video/:id`
- `/video/:id/highlights`

## API fő útvonalak

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/verify-email?token=...`
- `GET /api/auth/me`
- `GET /api/videos?hidden=false|true`
- `POST /api/videos/upload`
- `POST /api/videos/upload/init`
- `POST /api/videos/upload/chunk`
- `POST /api/videos/upload/complete`
- `POST /api/videos/upload/cancel`
- `POST /api/videos/upload/youtube/start`
- `GET /api/videos/upload/youtube/:importId`
- `POST /api/videos/upload/youtube/:importId/cancel`
- `GET /api/videos/:id`
- `DELETE /api/videos/:id`
- `PATCH /api/videos/:id/hidden`
- `PATCH /api/videos/:id/subtitle`
- `PATCH /api/videos/:id/whisper-settings`
- `POST /api/videos/:id/listen-request`
- `GET /api/videos/:id/highlights`
- `POST /api/videos/:id/highlights/analyze`
- `PATCH /api/videos/:id/highlights/clips/:clipId/feedback`
- `POST /api/videos/:id/highlights/export`

## Highlights funkció (MVP)

A highlights funkció 4 percnél hosszabb videóknál érhető el.

Folyamat:
1. A user megnyitja a `/video/:id/highlights` oldalt.
2. Kiválaszt egy célmódot (balanced/funny/emotional/informative/dynamic), majd elindítja a jelenetkeresést.
3. A rendszer szükség esetén Whisper átiratot készít, majd lefuttatja a highlight elemzést.
4. A szabályalapú jelöltekre opcionálisan lokális AI szemantikus újrapontozás fut (CPU-n), majd ez kerül visszarendezésre.
5. A találatok screenshottal, pontszámmal és indoklással jelennek meg, és az indoklásra visszajelzés adható (`helyes` / `helytelen`).
6. Ha a lokális AI nem elérhető, a rendszer automatikusan fallbackel a szabályalapú sorrendre.
7. A jobb oldali listából kiválasztott aktív klip középen finomhangolható custom timeline seek-kel.
8. A pontos tartomány editor-szerű `tól-ig` (kétfogantyús) klip csúszkával állítható.
9. A kezdő és végpont külön start/end mezőkben is pontosítható.
10. Exportnál egyszerre csak az aktív, pontosan beállított klip kerül külön videófájlba. Az új fájl új videóként kerül a listába.

## Token szabályok

- Videó feltöltés: `-2 token`
- Cím + hashtag generálás: `-10 token`
- Videó exportálás: `-1 token`
- Jelenetek keresése (highlight): `-2 token`
- Ha a jelenetek keresés előtt Whisper átirat kell: `-5 token / megkezdett perc`
- Aktív highlight klip export: `-3 token / klip`
- 1 hónapnál régebbi videó napi tárolási díja: `-1 token / videó / nap`
  A napi régi-videó díj ellenőrzés és levonás minden nap `16:00` után fut.
  Ha a usernek van 1 hónapnál régebbi videója, automatikus emlékeztető emailt kap.
- Regisztrációs jóváírás: `+350 token`
- Havi jóváírás (hó elején, ha 300 alatt van): `+100 token`

## Megjegyzés Gmailhez

A backend jelenleg `nodemailer`-t használ Gmail SMTP beállítással (`SMTP_USER`, `SMTP_PASS`).
Gmail esetén tipikusan App Password szükséges.

## Whisper telepítés

A backend worker a `WHISPER_COMMAND` binárist hívja. Javasolt a backendet futtató userrel telepíteni (pl. `winben`), ne rootként.

```bash
mkdir -p ~/whisper
cd ~/whisper

python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip setuptools wheel
pip install openai-whisper
```

Ellenőrzés:

```bash
~/whisper/.venv/bin/whisper --help
```

Backend `.env` beállítás:

```env
WHISPER_COMMAND=/home/winben/whisper/.venv/bin/whisper
WHISPER_QUEUE_POLL_MS=2500
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-3.5-turbo
OPENAI_TIMEOUT_MS=25000
```

Ha rootként telepítetted, a backend általában nem fogja látni a binárist a PATH-ban.

## YouTube import (yt-dlp)

A listaoldalon YouTube URL is megadható, és a rendszer yt-dlp-vel letölti a videót.
A folyamat ugyanúgy százalékos progress-szel jelenik meg, mint a normál feltöltés.

Backend `.env` opció:

```env
YTDLP_COMMAND=/home/winben/whisper/.venv/bin/yt-dlp
```

Ha `Precondition check failed` vagy `HTTP Error 403` hibát kapsz YouTube importnál, frissítsd a yt-dlp-t:

```bash
/home/winben/whisper/.venv/bin/pip install --upgrade yt-dlp
```

## Highlight runtime telepítés (Ubuntu 24.04)

Lokális NLP/Whisper alapú highlight feldolgozáshoz használható gyors telepítő:

```bash
bash scripts/install-highlight-runtime.sh
```

Opcionális környezeti változók:
- `TARGET_USER` (alapértelmezés: aktuális user)
- `TARGET_HOME` (alapértelmezés: `/home/$TARGET_USER`)
- `WHISPER_DIR` (alapértelmezés: `$TARGET_HOME/whisper`)
- `WHISPER_VENV_PATH` (alapértelmezés: `$WHISPER_DIR/.venv`)
- `WHISPER_COMMAND` (alapértelmezés: `$WHISPER_VENV_PATH/bin/whisper`)

Ajánlott backend `.env` beállítások a lokális AI rerankhez:

```env
HIGHLIGHT_AI_ENABLED=true
HIGHLIGHT_AI_PYTHON_COMMAND=/home/winben/whisper/.venv/bin/python
HIGHLIGHT_AI_SCRIPT_PATH=/home/winben/Dokumentumok/code/subtitle2/backend/scripts/highlight-rerank.py
HIGHLIGHT_AI_TIMEOUT_MS=90000
HIGHLIGHT_AI_BLEND=0.8
HIGHLIGHT_AI_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
```

## Backend startup és port kezelés

A backend induláskor alapból megpróbálja felszabadítani a `PORT`-ot (alapértelmezésben `3000`), ha azon már egy másik process figyel.  
Ez segít elkerülni az `EADDRINUSE` hibát fejlesztés közben.

Kikapcsolás `.env`-ben:

```env
FORCE_FREE_PORT_ON_START=false
```

Alapértelmezés: bekapcsolt (`true` viselkedés, ha nincs megadva).

## CI/CD (Self-hosted + Docker)

Részletes leírás:
- [docs/cicd-docker-telepites.md](docs/cicd-docker-telepites.md)
- [docs/fresh-production-server-todo.md](docs/fresh-production-server-todo.md)

A `selfhosted-cicd.yml` workflow teljesen Docker Compose deployt futtat (`scripts/deploy-selfhosted.sh`), PM2 nincs használatban.

Gyors telepítő (self-hosted runner + Docker deploy környezet):

```bash
bash scripts/install-selfhosted.sh
```

Friss, ures szerver bootstrap (telepites + env bootstrap + opcionális elso deploy):

```bash
bash scripts/install-fresh-production.sh
```

Kötelező GitHub secret a deployhoz:
- `ENV_DOCKER`
  tartalma a teljes `.env.docker` fájl (multiline)

Deploynál használt fő env-ek:
- `ENV_FILE_PATH` (alapértelmezés: `.env.docker`)
- `DOCKER_PROJECT_NAME` (alapértelmezés: `subtitle2`)
- `DOCKER_COMPOSE_FILES` (alapértelmezés: `docker-compose.yml`)

Cloudflare cache purge (CI után automatikusan) opcionális secret:
- `CF_CACHE_PURGE`
  tartalma:
  `CLOUDFLARE_API_TOKEN=...` és `CLOUDFLARE_ZONE_ID=...` (külön sorban)
