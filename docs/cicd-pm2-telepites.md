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
  - backend: `/var/www/winben`
  - frontend webroot: `/var/www/html`

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

A deploy backend célmappa: `/var/www/winben`.

Hozd létre és állítsd be a backend `.env` fájlt:

```bash
mkdir -p /var/www/winben/backend
nano /var/www/winben/backend/.env
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
2. frontend `npm run build`
3. backend `npm ci`
4. backend `npm run build`
5. deploy script futtatása

A deploy script:

- rsync-kel tükrözi a projektet a `BACKEND_DEPLOY_ROOT` alá (`/var/www/winben`)
- frontend buildet a `FRONTEND_WEB_ROOT` alá másolja (`/var/www/html`)
- megőrzi a backend `backend/.env` és `backend/data/subtitle2.sqlite` fájlokat
- backendben futtat `npm ci --omit=dev`
- PM2-vel indítja/újraindítja a szolgáltatást (`PM2_APP_NAME`, default: `winben`)
- `pm2 save`-ot hív

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
pm2 logs winben --lines 100
curl -I http://127.0.0.1:3000/api/auth/me
ls -la /var/www/html
```

## 7. Tipikus hibák

- `pm2 nincs telepítve`: telepítsd globálisan (`npm i -g pm2`).
- `dist/main.js hiányzik`: a backend build nem futott le CI-ben.
- `EADDRINUSE`: már fut egy másik process a 3000-es porton.
- Frontend nem frissül weben: ellenőrizd, hogy a workflow a `/var/www/html`-ba deployol, és a webszerver ezt a könyvtárat szolgálja ki.
