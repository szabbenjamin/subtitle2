# subtitle2

Teljes stack projekt két mappában:
- `frontend`: Angular 21 PWA
- `backend`: NestJS 11 + SQLite

## Fejlesztői indítás

Használj két terminált: egyet backendhez, egyet frontendhez.

### Backend dev szerver

```bash
source ~/.nvm/nvm.sh
nvm use 24

cd backend
cp .env.example .env
npm install
npm run start:dev
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

## Fő route-ok

- `/login`
- `/login/reset?resetToken=...`
- `/lista`
- `/video/:id`

## API fő útvonalak

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/verify-email?token=...`
- `GET /api/auth/me`
- `GET /api/videos?hidden=false|true`
- `POST /api/videos/upload`
- `GET /api/videos/:id`
- `PATCH /api/videos/:id/hidden`
- `PATCH /api/videos/:id/subtitle`
- `POST /api/videos/:id/listen-request`

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

## Backend startup és port kezelés

A backend induláskor alapból megpróbálja felszabadítani a `PORT`-ot (alapértelmezésben `3000`), ha azon már egy másik process figyel.  
Ez segít elkerülni az `EADDRINUSE` hibát fejlesztés közben.

Kikapcsolás `.env`-ben:

```env
FORCE_FREE_PORT_ON_START=false
```

Alapértelmezés: bekapcsolt (`true` viselkedés, ha nincs megadva).

## CI/CD + PM2 telepítés

Részletes leírás:
- [docs/cicd-pm2-telepites.md](/home/winben/subtitle2/docs/cicd-pm2-telepites.md)
