# Backend Playbook (subtitle2)

Ez a dokumentum egy gyakorlati induló guide a `frontend` (Angular PWA) és `backend` (NestJS + SQLite) közötti együttműködéshez.
Cél: legközelebb gyorsan, stabilan lehessen backendes appot építeni ugyanilyen mintára.

## 1. Projekt-alapelv

- Monorepo szerkezet:
  - `frontend/` = Angular app
  - `backend/` = NestJS app
- Nincs külön API domain a klienstől.
- A frontend **minden backend hívása** `/api/...` prefixet használ.
- Webszerveren/proxy-n a `/api/...` route-ok a NestJS felé mennek.

## 2. Futtatási környezet

- Node: `nvm use 24`
- Backend default port: `3000`
- DB: SQLite (`SQLITE_PATH`)
- Upload könyvtár: `.env`-ből (`UPLOADS_DIR`)

## 3. API szerződés mintázat

- Globális API prefix: `api`
- Auth minden védett endpointon: `Authorization: Bearer <jwt>`
- Frontend oldalon interceptor teszi rá a JWT-t.
- Védett backend route-ok: `@UseGuards(JwtAuthGuard)`

## 4. Auth flow

Endpointok:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/verify-email?token=...`
- `GET /api/auth/me`

Megjegyzések:

- Regisztráció után email megerősítés kötelező.
- `/api/auth/me` a frontend “source of truth” a user profilhoz.
- Profilban benne van a token egyenleg is (`tokenBalance`).

## 5. Frontend auth és state

- `AuthService` signal állapotot tart:
  - `isLoggedIn`
  - `profile`
- Token localStorage kulcs a projekt nevéből származik
- App induláskor ha van token: `me()` hívás, különben logout állapot.

## 6. Levelezés (SMTP) működés

Backend oldali minta:

- Külön `MailModule` + `MailService` legyen.
- A service egyetlen felelőssége:
  - SMTP kliens inicializálása
  - sablon alapú email küldés
- Az auth/business service csak meghívja (ne ott legyen SMTP logika).

Ajánlott környezeti változók:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `FRONTEND_BASE_URL` (tokenes linkekhez)

Tokenes auth levelek tipikus esetei:

- Email megerősítés:
  - backend generál egyszer használható token-t
  - email link: `${FRONTEND_BASE_URL}/login?verifyToken=...`
- Elfelejtett jelszó:
  - backend generál lejáró reset token-t
  - email link: `${FRONTEND_BASE_URL}/login/reset?resetToken=...`

Biztonsági szabályok:

- Soha ne logolj tokeneket.
- Reset/verify token legyen:
  - hosszú, véletlen
  - egyszer használható
  - lejárati időhöz kötött (különösen resetnél)
- “Forgot password” endpoint mindig semleges választ adjon
  - ne árulja el, létezik-e az email cím.

Hibatűrés:

- Küldési hiba ne törje szét a teljes kérést kontrollálatlanul.
- Legyen egyértelmű üzleti döntés:
  - vagy hard-fail (pl. regisztráció csak sikeres email küldéssel),
  - vagy soft-fail + retry queue.

Skálázható minta:

- Nagyobb terhelésnél a levélküldést queue-ba érdemes tenni
  - pl. BullMQ worker
  - HTTP kérés csak enqueue-ol, a worker küld.

## 11. Chunkolt feltöltés minta

- Init: `POST /api/videos/upload/init`
- Chunk: `POST /api/videos/upload/chunk`
- Complete: `POST /api/videos/upload/complete`
- Cancel: `POST /api/videos/upload/cancel`

Javasolt chunk méret: `10MB`.

Követelmények:

- Feltöltés megszakítható legyen frontendről.
- Backend takarítsa a részleges fájlokat (cancel/error).
- Token levonás csak véglegesítéskor történjen.

## 12. Worker / háttérfolyamat minta

- Nagyobb erőforrásigényes megoldások külön child processben fusson (ne a main HTTP szálban).

## 16. Hibakezelési szabály

Backend:

- Konkrét, emberi üzenetet adjon `message` mezőben.

Frontend:

- Ne `window.alert`.
- Központi globális alert modal szolgáltatás.
- Modal nyitva: háttér document legyen `inert`, ne lehessen kattintani/fókuszálni.
- Blob típusú HTTP hiba payloadból is ki kell olvasni az üzenetet (file exportnál fontos).

## 17. UI loading anti-stuck szabály

Minden listázós oldalnál:

- API hívásra `timeout(...)`
- `finalize(...)`-ben biztosan `isLoading = false`
- Így nincs végtelen "Betöltés..." beragadás.

## 19. CORS / statikus média

Backend:

- `enableCors({ origin: true, credentials: true })`
- feltöltött média statikusan:
  - `/api/uploads/...`

## 20. Környezeti változók (minták)

- `PORT`
- `SQLITE_PATH`
- `UPLOADS_DIR`
- `JWT_SECRET`
- `FRONTEND_BASE_URL`
- `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `WHISPER_COMMAND`, `WHISPER_QUEUE_POLL_MS`, `WHISPER_WORKER_AUTOSTART`
- `FORCE_FREE_PORT_ON_START`

## 21. Stabil indulási checklist új backend projekthez

2. Legyen `/api` prefix + JWT guard + auth interceptor.
3. Készíts közös hibaformátumot (`message`).
4. Chunk upload + cancel + cleanup eleve legyen.
6. Külön worker process hosszú feladatokra.
7. Admin funkciókat backend oldalon is zárd.
8. Frontenden globális alert modal + loading finalize.
9. Build ellenőrzés: backend + frontend (Node 24).

## 22. Mit érdemes elkerülni

- Csak frontend oldali jogosultságellenőrzés.
- Generikus fallback hiba mindenre (elrejti a valós okot).
- Olyan loading flag, ami nem áll vissza hiba/timeout esetén.
- Hosszú folyamat main HTTP szálon.
- Token levonás művelet után (inkonzisztenciát okoz).
