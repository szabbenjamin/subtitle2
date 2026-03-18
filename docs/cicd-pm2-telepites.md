# CI/CD + PM2 telepítés (self-hosted)

Ez a dokumentáció a `.github/workflows/selfhosted-cicd.yml` workflow, a `scripts/deploy-selfhosted.sh` deploy script és a `scripts/install-selfhosted.sh` telepítő használatát írja le.

## 1. Gyors telepítés (installer)

A legegyszerűbb út:

```bash
cd /path/to/repo
bash scripts/install-selfhosted.sh
```

Ez telepíti/ellenőrzi:

- Node 24 (`nvm`-mel)
- `pm2`
- `rsync`
- deploy könyvtárak:
  - backend: `/home/winben/subtitle2`
  - frontend webroot: `/var/www/html`
- PM2 app név: `subtitle2`
- futtatási user: `winben`

Opcionálisan a GitHub runner konfiguráció is automatizálható:

```bash
export RUNNER_URL=\"https://github.com/<owner>/<repo>\"
export RUNNER_TOKEN=\"<registration-token>\"
bash scripts/install-selfhosted.sh
```

## 2. Előfeltételek a szerveren (manuális)

- Linux szerver
- GitHub self-hosted runner telepítve (`self-hosted`, `linux` label)
- Node.js 24 + npm
- `pm2` globálisan telepítve
- `rsync` telepítve

Példa:

```bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
npm i -g pm2
sudo apt-get install -y rsync
```

## 3. Backend környezet előkészítése

A deploy backend célmappa: `/home/winben/subtitle2`.

Hozd létre és állítsd be a backend `.env` fájlt:

```bash
mkdir -p /home/winben/subtitle2/backend
nano /home/winben/subtitle2/backend/.env
```

Minimum ajánlott tartalom:

```env
PORT=3000
SQLITE_PATH=data/subtitle2.sqlite
UPLOADS_DIR=uploads
JWT_SECRET=please-change-this-secret
FRONTEND_BASE_URL=https://subtitle2.winben.hu
WHISPER_COMMAND=/home/winben/whisper/.venv/bin/whisper
WHISPER_QUEUE_POLL_MS=2500
```

## 4. Workflow működése

A `selfhosted-cicd.yml` push-ra (main/master) és manuálisan fut.

Lépések:

1. frontend `npm ci`
2. frontend unit tesztek (`npm test -- --watch=false`)
3. frontend `npm run build`
4. backend `npm ci`
5. backend unit tesztek (`npm test -- --runInBand`)
6. backend `npm run build`
7. deploy script futtatása
8. Cloudflare teljes cache purge (ha a szükséges GitHub secretek be vannak állítva)

A deploy script:

- rsync-kel tükrözi a projektet a `BACKEND_DEPLOY_ROOT` alá (`/home/winben/subtitle2`)
- frontend buildet a `FRONTEND_WEB_ROOT` alá másolja (`/var/www/html`)
- megőrzi a backend `backend/.env` és `backend/data/subtitle2.sqlite` fájlokat
- backendben futtat `npm ci --omit=dev` (a `winben` user nevében)
- PM2-vel indítja/újraindítja a szolgáltatást (`PM2_APP_NAME`, default: `subtitle2`)
- `pm2 save`-ot hív
- sikeres deploy után Cloudflare API-val `purge_everything` hívást küld

### Cloudflare purge beállítás

A workflow Cloudflare purge lépése két GitHub secretet használ:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`

Az API tokenhez minimálisan szükséges jogosultság:
- Zone: `Cache Purge` (Edit)
- Zone scope: az adott domain zónája

## 5. PM2 tartós indulás (boot után is)

Egyszer futtasd:

```bash
pm2 startup
# a parancs kiír egy sudo parancsot, azt futtasd le
pm2 save
```

## 6. Ellenőrzés

```bash
pm2 list
pm2 logs subtitle2 --lines 100
curl -I http://127.0.0.1:3000/api/auth/me
ls -la /var/www/html
```

## 7. Tipikus hibák

- `pm2 nincs telepítve`: telepítsd globálisan (`npm i -g pm2`).
- `dist/main.js hiányzik`: a backend build nem futott le CI-ben.
- `EADDRINUSE`: már fut egy másik process a 3000-es porton.
- Frontend nem frissül weben: ellenőrizd, hogy a workflow a `/var/www/html`-ba deployol, és a webszerver ezt a könyvtárat szolgálja ki.
