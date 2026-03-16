# subtitle2 CI/CD + PM2 telepítés

Ez a dokumentáció a `.github/workflows/selfhosted-cicd.yml` workflow és a `scripts/deploy-selfhosted.sh` script telepítését írja le.

## 1. Előfeltételek a szerveren

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

## 2. Backend környezet előkészítése

A deploy célmappa alapértelmezésben: `/var/www/subtitle2`.

Hozd létre és állítsd be a backend `.env` fájlt:

```bash
mkdir -p /var/www/subtitle2/backend
nano /var/www/subtitle2/backend/.env
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

## 3. Workflow működése

A `selfhosted-cicd.yml` push-ra (main/master) és manuálisan fut.

Lépések:

1. frontend `npm ci`
2. frontend `npm run build`
3. backend `npm ci`
4. backend `npm run build`
5. deploy script futtatása

A deploy script:

- rsync-kel tükrözi a projektet a `DEPLOY_ROOT` alá
- megőrzi a `backend/.env` és `backend/data/subtitle2.sqlite` fájlokat
- backendben futtat `npm ci --omit=dev`
- PM2-vel indítja/újraindítja a szolgáltatást (`PM2_APP_NAME`, default: `subtitle2-backend`)
- `pm2 save`-ot hív

## 4. PM2 tartós indulás (boot után is)

Egyszer futtasd:

```bash
pm2 startup
# a parancs kiír egy sudo parancsot, azt futtasd le
pm2 save
```

## 5. Ellenőrzés

```bash
pm2 list
pm2 logs subtitle2-backend --lines 100
curl -I http://127.0.0.1:3000/api/auth/me
```

## 6. Tipikus hibák

- `pm2 nincs telepítve`: telepítsd globálisan (`npm i -g pm2`).
- `dist/main.js hiányzik`: a backend build nem futott le CI-ben.
- `EADDRINUSE`: már fut egy másik process a 3000-es porton.
