# subtitle2 – Részletes projekt kézikönyv

Ez a dokumentum a jelenlegi implementáció alapján, fejlesztői és üzemeltetői nézetből írja le a `subtitle2` teljes működését.

- Frontend: Angular 21 (PWA)
- Backend: NestJS 11 + TypeORM
- Adatbázis: MySQL 8.4
- Média/NLP runtime: ffmpeg, Whisper CLI, yt-dlp, lokális embedding alapú highlight újrapontozás

## 1. A rendszer célja

A rendszer célja, hogy a felhasználó:
- videót vagy audio fájlt töltsön fel (vagy YouTube-ról importáljon),
- automatikus átírást készítsen (Whisper),
- feliratot szerkesszen,
- a feliratot videóra égesse,
- social meta szöveget (cím + hashtag) generáljon,
- 4 percnél hosszabb videóknál highlight klipeket keressen és exportáljon.

## 2. Funkcionális áttekintés

Fő user funkciók:
- regisztráció, email megerősítés, login, jelszó-visszaállítás,
- aktív/rejtett videólista,
- fájlfeltöltés chunkolt módban,
- YouTube import (`yt-dlp`) progress visszajelzéssel,
- videó törlés (végleges, megerősítéssel),
- videó részletező oldal:
  - lejátszás,
  - Whisper beállítások (user profil szinten),
  - felirat autosave,
  - sablonkezelés,
  - export (ASS burn),
  - social text generálás,
- highlights oldal:
  - jelenetkeresés célmóddal,
  - timeline + tartomány finomhangolás,
  - klip export új videóként,
  - indoklás-visszajelzés.

Rendszer oldali kiegészítők:
- token alapú elszámolás,
- napi 16:00 után régi videó tárolási díj + email értesítés,
- árva fájlok takarítása az uploads könyvtárból,
- worker process Whisper és highlight queue feldolgozásra.

## 3. Képernyők és kattintás-flow

### 3.1 Login oldal (`/login`)

Fő elemek:
- Hero blokk + modális auth flow (Belépés / Regisztráció / Elfelejtett jelszó / Reset).
- Query param alapú automata flow:
  - `?verifyToken=...` → email megerősítés,
  - `/login/reset?resetToken=...` → reset modal.

Működés:
1. `Belépés` gomb → `POST /api/auth/login`.
2. Siker esetén JWT localStorage (`subtitle2_token`), majd profil lekérés (`GET /api/auth/me`).
3. Navigáció: `/lista`.

### 3.2 Fő fejléc (globális shell)

Fejléc elemek:
- `Lista`, `Token` egyenleg, adminnál `Admin`, téma-váltó, `Kilépés`.
- Globális alert modal minden oldalon közös.
- PWA install bar (`beforeinstallprompt`).

### 3.3 Lista oldal (`/lista`)

#### 3.3.1 Fájl feltöltés

Flow:
1. `Új videó feltöltése` → fájlválasztó.
2. `Feltöltés` → chunkolt upload indul (`10 MB` chunkok):
   - `POST /api/videos/upload/init`
   - `POST /api/videos/upload/chunk` (ismétlődő)
   - `POST /api/videos/upload/complete`
3. Feltöltés közben a listában egy placeholder sor jelenik meg az Aktív videók tetején.
4. Siker esetén navigáció a videó oldalra.

Megjegyzés:
- Aktív fájlfeltöltés alatt oldalelhagyásnál warning jelenik meg (`CanDeactivate + beforeunload`).
- Ha a user elnavigál/bezárja az oldalt, a fájlfeltöltés megszakad.

#### 3.3.2 YouTube import

Flow:
1. YouTube URL megadása + `YouTube letöltés`.
2. Backend import task indul (`POST /api/videos/upload/youtube/start`), frontend polling:
   - `GET /api/videos/upload/youtube/:importId`.
3. Placeholder sor és progress update folyamatos.
4. Siker esetén videó oldalra navigál.

Megjegyzés:
- YouTube importnál a kliens oldali követés leválasztható (`detach`), ezért elnavigálás után is folytatódik backend oldalon.
- A futó import azonosítója localStorage-ben mentésre kerül (`subtitle2.activeYoutubeImport`), visszanavigáláskor a UI újracsatlakozik.

#### 3.3.3 Lista műveletek

- `Elrejtés` / `Visszaállítás`: `PATCH /api/videos/:id/hidden`.
- `Törlés`: megerősítő modal után `DELETE /api/videos/:id`.
- `Megnyitás`: navigáció `/video/:id`.

### 3.4 Videó oldal (`/video/:id`)

Oldalszerkezet:
- Bal oszlop: videó preview + Whisper blokk + állapot.
- Közép: felirat textarea (autosave).
- Jobb oszlop: sablonkezelés + export + social generálás.

#### 3.4.1 Kezdeti médiafeldolgozás állapot

Ha a videó `processingStatus` értéke `pending`, akkor:
- csak `Feldolgozás folyamatban...` jelenik meg,
- Whisper beállítás panel és `Lehallgatom` gomb nem jelenik meg.

#### 3.4.2 Whisper beállítások

- Modell fix: `turbo`.
- Nyelv és `szó/sor` user profilhoz kötött (nem videóhoz).
- Mentés: `PATCH /api/auth/me/whisper-settings`.

`Lehallgatom` gomb:
- először menti a user whisper beállítást,
- majd `POST /api/videos/:id/listen-request`.
- A tényleges átirat háttér workerben készül.

#### 3.4.3 Felirat szerkesztés

- textarea változás debounce után mentődik:
  - `PATCH /api/videos/:id/subtitle`.
- mentési státusz megjelenik a UI-n.

#### 3.4.4 Felirat sablon kezelés

- Sablon lista és CRUD:
  - `GET /api/subtitle-presets`
  - `POST /api/subtitle-presets`
  - `PATCH /api/subtitle-presets/:id`
  - `DELETE /api/subtitle-presets/:id`
- Videóhoz rendelés:
  - `PATCH /api/videos/:id/subtitle-preset`.

#### 3.4.5 Export és social

- `Exportálás`:
  - `POST /api/videos/:id/export` (blob letöltés).
- `Generálás` (social text):
  - `POST /api/videos/:id/social-text`.
- `TXT letöltés`: kliens oldali blob fájl.

### 3.5 Highlights oldal (`/video/:id/highlights`)

Elérhetőség:
- legalább 4 perces videónál (`durationSeconds >= 240`).

Fő működés:
1. `Jelenetek keresése` (célmód kiválasztással) → `POST /api/videos/:id/highlights/analyze`.
2. UI polling: `GET /api/videos/:id/highlights`.
3. Középen custom videólejátszó + timeline.
4. Aktív kliphez kétfogantyús tól-ig csúszka és numerikus start/end szerkesztés.
5. Lejátszásnál az aktív klip végén a videó automatikusan megáll.
6. Találatok listája screenshot + indoklás + transcript snippet adatokkal.
7. Visszajelzés: `Helyes` / `Helytelen` → `PATCH /api/videos/:id/highlights/clips/:clipId/feedback`.
8. `Aktív klip exportálása` → `POST /api/videos/:id/highlights/export`.
9. Siker után `Klip megnyitása` gomb jelenik meg.

## 4. Backend feldolgozási pipeline-ok

### 4.1 Feltöltés és normalizálás

#### 4.1.1 Direkt upload (`POST /api/videos/upload`)

- token levonás: `-2` (`video_upload`),
- azonnal létrejön egy `pending` videó rekord,
- nehéz feldolgozás háttér queue-ban fut:
  - szükség esetén konvertálás H.264/AAC MP4-re,
  - duration detektálás,
  - thumbnail generálás,
  - státusz `idle`.

#### 4.1.2 Chunkolt upload

- Session init + chunkok fogadása memória storage-dzsel,
- session végén chunk fűzés fájlba,
- token levonás,
- ugyanaz a háttér normalizálási queue.

#### 4.1.3 Formátum normalizálás szabály

A rendszer akkor konvertál, ha nem teljesül egyszerre:
- konténer: MP4,
- videó codec: H.264,
- audio codec: AAC (vagy nincs audio stream).

FFmpeg konverzió:
- `libx264` + `aac`,
- `-preset superfast`,
- `+faststart`,
- bitráta megőrzés jelleggel skálázva:
  - video: `*1.3`,
  - audio: `*1.15`.

### 4.2 Thumbnail szabályok

- Normál feltöltött videó thumbnail: videó 2. másodperce (rövidnél fallback).
- Highlight exportált klip thumbnail: klip 0. másodperce.

### 4.3 YouTube import pipeline

Állapotok:
- `queued` → `downloading` → `processing` → `completed|failed|cancelled`.

Lépések:
1. URL validálás (csak YouTube hostok).
2. `yt-dlp` spawn (`--no-playlist --merge-output-format mp4`).
3. progress parse stdout/stderr alapján.
4. letöltött fájl keresése prefix alapján.
5. token levonás uploadért.
6. média normalizálás.
7. videó rekord létrehozás.

Hibakezelés:
- ismert 400/403/`nsig` jellegű hibákra userbarát üzenet,
- részletes log backend oldalon.

### 4.4 Whisper worker pipeline

A fő backend process induláskor child worker processzt indít (ha nincs tiltva).

Queue feltételek:
- `videos.listenRequested = true` és `processingStatus = queued`.

Lépések:
1. rekord `pending` státusz,
2. whisper futtatás (`WHISPER_COMMAND`),
3. SRT beolvasás,
4. transcript normalizálás:
   - sorvégi írásjelek eltávolítása,
   - sor eleji nagybetű kisbetűsítése,
5. mentés `subtitleText`, státusz `idle`, `listenRequested=false`.

### 4.5 Highlight pipeline

Highlight analysis rekord (`video_highlight_analyses`) státusz flow:
- `queued` → `processing` → `completed|failed`.

Fő lépések:
1. transcript biztosítása:
   - ha nincs, előbb Whisper fallback.
2. szabályalapú jelöltképzés:
   - SRT ablakokra bontás,
   - feature számítás (beszédsűrűség, humor/emotion/info/dynamic kulcsszavak, stb.),
   - módfüggő súlyozás.
3. lokális AI újrapontozás (ha engedélyezett):
   - Python script (`backend/scripts/highlight-rerank.py`),
   - embedding modell: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`,
   - blend (`HIGHLIGHT_AI_BLEND`) a rule score és AI score között,
   - indoklásba beemelt `AI szemantikus illeszkedes` feature.
4. minimális átfedéses deduplikálás jelöltek között.
5. screenshot készítés jelöltenként.
6. klip rekordok mentése (`video_highlight_clips`).

### 4.6 Highlight feedback alapú tanulás

A user visszajelzés (`helyes/helytelen`) hatására frissül:
- `data/highlight-learning.json`.

Ezt a profil a következő scoringnál `learningFactor` formában használja, feature-enként/módonként.

### 4.7 Highlight export pipeline

`POST /api/videos/:id/highlights/export`:
- token levonás: `-3 / klip`,
- ffmpeg vágás H.264/AAC MP4-be,
- új videó rekord készül (mint egy új feltöltés),
- `subtitleText` alapból üres,
- whisper nem indul automatikusan.

## 5. Token szabályrendszer

Jelenlegi díjszabás:
- Videó feltöltés: `-2 token`
- Cím + hashtag generálás: `-10 token`
- Videó exportálás: `-1 token`
- Jelenetek keresése: `-2 token`
- Whisper lehallgatás: `-5 token / megkezdett perc`
- Aktív highlight klip export: `-3 token / klip`
- 1 hónapnál régebbi videó napi díja: `-1 token / videó / nap`
- Regisztrációs jóváírás: `+350 token`
- Havi jóváírás (ha 300 alatt): `+100 token`

History tábla:
- `token_history`, frontend oldalon 20 soros lapozott megjelenítéssel (`További megjelenítése`).

## 6. Napi régi videó díj scheduler

Szolgáltatás: `OldVideoStorageFeeService`.

- 1 perces tick,
- naponta egyszer fut 16:00 után,
- 30 napnál régebbi videók után próbál levonni,
- video-szintű napi idempotencia (`videoId=` leírásból),
- minden érintett user kap email emlékeztetőt.

## 7. Árva fájl takarítás

Szolgáltatás: `UploadsOrphanCleanupService`.

Mit csinál:
- rekurzívan bejárja `UPLOADS_DIR` tartalmát,
- DB referenciahalmazt épít (`videos.storageFileName`, `videos.thumbnailFileName`, `highlight clips.screenshotFileName`),
- a nem referált és elég régi fájlokat törli.

Konfig:
- `UPLOADS_ORPHAN_SWEEP_INTERVAL_MS`
- `UPLOADS_ORPHAN_MIN_AGE_MINUTES`

## 8. Adatmodell (MySQL)

Fő táblák:
- `users`
- `videos`
- `subtitle_presets`
- `video_highlight_analyses`
- `video_highlight_clips`
- `token_history`

### 8.1 `users`

Fontos mezők:
- auth: `email`, `passwordHash`, `isEmailVerified`, reset/verify token mezők,
- token: `tokenBalance`, `lastTokenTopupMonth`,
- whisper user beállítás: `whisperLanguage`, `wordsPerLine`.

### 8.2 `videos`

Fontos mezők:
- fájl: `originalFileName`, `storageFileName`, `thumbnailFileName`,
- meta: `durationSeconds`, `fileSizeBytes`,
- állapot: `processingStatus`, `listenRequested`,
- tartalom: `subtitleText`, `socialTextCombined`,
- kapcsolatok: owner, subtitle preset.

### 8.3 `video_highlight_analyses` és `video_highlight_clips`

- analysis: állapot/progress/stage/error/requiresWhisper,
- clip: rank, score, start/end, screenshot, snippet, reasons JSON, feedback.

### 8.4 `token_history`

- `delta`, `balanceAfter`, `type`, `description`, `createdAt`.

## 9. API szerződés (főbb endpoint csoportok)

### 9.1 Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/verify-email?token=...`
- `GET /api/auth/me`
- `PATCH /api/auth/me/whisper-settings`

### 9.2 Videók

- `GET /api/videos?hidden=false|true`
- `GET /api/videos/:id`
- `DELETE /api/videos/:id`
- `PATCH /api/videos/:id/hidden`
- `PATCH /api/videos/:id/subtitle`
- `PATCH /api/videos/:id/subtitle-preset`
- `PATCH /api/videos/:id/whisper-settings` (kompatibilitási endpoint)
- `POST /api/videos/:id/listen-request`
- `POST /api/videos/:id/export`
- `POST /api/videos/:id/social-text`

### 9.3 Upload

- `POST /api/videos/upload`
- `POST /api/videos/upload/init`
- `POST /api/videos/upload/chunk`
- `POST /api/videos/upload/complete`
- `POST /api/videos/upload/cancel`

### 9.4 YouTube import

- `POST /api/videos/upload/youtube/start`
- `GET /api/videos/upload/youtube/:importId`
- `POST /api/videos/upload/youtube/:importId/cancel`

### 9.5 Highlights

- `GET /api/videos/:id/highlights`
- `POST /api/videos/:id/highlights/analyze`
- `PATCH /api/videos/:id/highlights/clips/:clipId/feedback`
- `POST /api/videos/:id/highlights/export`

### 9.6 Token és admin

- `GET /api/tokens/balance`
- `GET /api/tokens/history`
- `GET /api/tokens/admin/users` (admin emailhez kötött)
- `PATCH /api/tokens/admin/users/:id/balance`

### 9.7 Felirat sablonok

- `GET /api/subtitle-presets`
- `POST /api/subtitle-presets`
- `PATCH /api/subtitle-presets/:id`
- `DELETE /api/subtitle-presets/:id`

## 10. Környezeti változók

A backend fail-fast validációja kötelezőként kezeli (nem test környezetben):
- `JWT_SECRET`
- `FRONTEND_BASE_URL`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `WHISPER_COMMAND`
- `YTDLP_COMMAND`
- `OPENAI_API_KEY`

További fontos opciók:
- `DB_SYNCHRONIZE`
- `WHISPER_QUEUE_POLL_MS`
- `DB_BUSY_RETRY_ATTEMPTS`
- `DB_BUSY_RETRY_DELAY_MS`
- `HIGHLIGHT_AI_ENABLED`
- `HIGHLIGHT_AI_PYTHON_COMMAND`
- `HIGHLIGHT_AI_SCRIPT_PATH`
- `HIGHLIGHT_AI_MODEL`
- `HIGHLIGHT_AI_BLEND`
- `HIGHLIGHT_AI_TIMEOUT_MS`
- `UPLOADS_ORPHAN_SWEEP_INTERVAL_MS`
- `UPLOADS_ORPHAN_MIN_AGE_MINUTES`

## 11. Docker topológia

`docker-compose.yml` szolgáltatások:
- `db` (MySQL 8.4)
- `backend` (Nest + Whisper + yt-dlp + AI runtime)
- `frontend` (Nginx + Angular build)

Volume/mount pontok `.env.docker` alapján:
- `MYSQL_DATA_DIR`
- `BACKEND_UPLOADS_DIR`
- `BACKEND_DATA_DIR`
- `WHISPER_CACHE_DIR`

Nginx fő sajátosságok:
- `client_max_body_size 64m`,
- `/api/` proxy backendre,
- hosszú timeoutok nagyobb feldolgozási műveletekhez.

## 12. Dev mód és watcher

`docker-compose.dev.yml`:
- backend `npm run start:dev`,
- frontend `ng serve` pollinggal,
- bind mountok forráskódra,
- cél: módosítás utáni automatikus újraépülés dev környezetben.

## 13. CI/CD (self-hosted)

Workflow: `.github/workflows/selfhosted-cicd.yml`.

Fő lépések:
1. checkout,
2. `.env.docker` generálás `ENV_DOCKER` secretből,
3. frontend + backend teszt + build,
4. deploy: `bash scripts/deploy-selfhosted.sh`,
5. opcionális Cloudflare cache purge (`CF_CACHE_PURGE`).

Megjegyzés:
- a deploy script nem törli a DB-t, a DB megőrzése a bind mount útvonal stabilitásán múlik (`MYSQL_DATA_DIR`).

## 14. Naplózás és monitorozás

Backend/worker intenzíven logol:
- feltöltés indítás/lezárás,
- chunk progress események,
- konvertálás szükséges/kihagyva + ffmpeg paraméterek,
- whisper queue és highlight queue állapotok,
- AI rerank használva/fallback,
- scheduler futások (régi videó díj, orphan cleanup),
- YouTube import részletek és hibák.

Javasolt figyelési pontok élesben:
- `subtitle2-backend` konténer log,
- worker error stackek,
- `processingStatus` beragadások,
- DB lock jelzések,
- `yt-dlp` HTTP 403/400 hibák.

## 15. Hibaelhárítás (rövid)

### 15.1 413 Request Entity Too Large

Tünet:
- upload előtt Nginx 413.

Ellenőrzés:
- frontend nginx configban `client_max_body_size`.

### 15.2 YouTube 403 / Precondition check failed

Tünet:
- import failed.

Teendő:
- `yt-dlp` frissítés a használt venv-ben,
- `YTDLP_COMMAND` helyes binary-re állítása.

### 15.3 Whisper ENOENT

Tünet:
- worker nem talál whisper binárist.

Teendő:
- `WHISPER_COMMAND` validálása,
- telepítő script futtatása (`scripts/install-highlight-runtime.sh`),
- executable jogosultság ellenőrzése.

### 15.4 SQLITE_BUSY (korábbi SQLite környezetből)

Jelen állapot:
- projekt MySQL-re van állítva.

Ha mégis előjön:
- ellenőrizni, hogy tényleg MySQL env-ekkel fut-e a backend,
- worker retry env-ek (`DB_BUSY_RETRY_*`).

## 16. Ismert korlátok

- A direkt/ chunk upload kliens oldali megszakításra érzékeny (nem resumable upload).
- YouTube import állapottárolása kliens oldali localStorage-re támaszkodik.
- Admin jogosultság jelenleg hardcoded emailhez kötött.
- Social text generálás külső OpenAI API-t igényel (`OPENAI_API_KEY`).
- Highlight pipeline főleg transcript jellegzetességeken alapul; audio/vizuális deep signal nincs.

## 17. Továbbfejlesztési javaslatok

- role/permission rendszer (admin email hardcode kiváltása),
- job queue infrastruktúra (Redis + dedikált worker pool),
- resumable upload protocol (pl. tus) nagy fájlokra,
- observability stack (structured logs + metrics + traces),
- migration alapú DB sémakezelés `synchronize` helyett,
- finomabb highlight quality model + multimodális feature-ek.

---

Doksi státusz: a jelenlegi kódbázisra igazítva (`main` branch állapot, 2026-04-15).
