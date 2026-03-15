# subtitle2

Teljes stack projekt két mappában:
- `frontend`: Angular 21 PWA
- `backend`: NestJS 11 + SQLite

## Fejlesztői indítás

```bash
source ~/.nvm/nvm.sh
nvm use 24

cd backend
cp .env.example .env
npm install
npm run start:dev
```

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
