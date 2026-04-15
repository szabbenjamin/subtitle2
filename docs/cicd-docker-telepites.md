# CI/CD + Docker telepítés (self-hosted)

Ez a dokumentáció a `.github/workflows/selfhosted-cicd.yml` workflow, a `scripts/install-selfhosted.sh` telepítő és a `scripts/deploy-selfhosted.sh` deploy script Docker-alapú használatát írja le.

## 1. Gyors telepítés (installer)

A legegyszerűbb út:

```bash
cd /path/to/repo
bash scripts/install-selfhosted.sh
```

A script telepíti/ellenőrzi:
- Docker Engine
- Docker Compose plugin (`docker compose`)
- bind mount mappákat a `.env.docker` szerint (`MYSQL_DATA_DIR`, `BACKEND_UPLOADS_DIR`, `BACKEND_DATA_DIR`, `WHISPER_CACHE_DIR`)
- opcionálisan GitHub Actions self-hosted runner service-t

Opcionális runner automatizálás:

```bash
export RUNNER_URL="https://github.com/<owner>/<repo>"
export RUNNER_TOKEN="<registration-token>"
bash scripts/install-selfhosted.sh
```

## 2. Kötelező CI secret

A workflow elvárt secretje:
- `ENV_DOCKER`: a teljes `.env.docker` tartalom (multiline)

A workflow futáskor ebből készíti el:
- `.env.docker`
- `.env` symlinket (`.env -> .env.docker`)

Ha ez a secret hiányzik, a workflow fail-fast leáll.

## 3. Workflow működése

A `selfhosted-cicd.yml` push-ra (`main`/`master`) és manuálisan is fut.

Lépések:
1. checkout
2. `.env.docker` létrehozás `ENV_DOCKER` secretből
3. frontend install + teszt + build
4. backend install + teszt + build
5. Docker deploy (`scripts/deploy-selfhosted.sh`)
6. opcionális Cloudflare purge (`CF_CACHE_PURGE` secret esetén)

A deploy script:
- validálja a Docker és Compose elérhetőséget
- validálja a compose fájl(oka)t
- előkészíti a bind mount mappákat
- futtatja a `docker compose ... up --build -d --remove-orphans` parancsot
- kiírja a `docker compose ps` állapotot

## 4. Deploy script környezeti változók

- `ENV_FILE_PATH` (default: `.env.docker`)
- `DOCKER_PROJECT_NAME` (default: `subtitle2`)
- `DOCKER_COMPOSE_FILES` (default: `docker-compose.yml`, több fájl vesszővel adható meg)
- `DOCKER_PULL_BEFORE_UP` (default: `false`)
- `TARGET_USER` (mappa ownership fallbackhoz)

Példa kézi futtatás:

```bash
ENV_FILE_PATH=.env.docker \
DOCKER_PROJECT_NAME=subtitle2 \
DOCKER_COMPOSE_FILES=docker-compose.yml \
bash scripts/deploy-selfhosted.sh
```

## 5. Cloudflare purge (opcionális)

A workflow használhatja a `CF_CACHE_PURGE` secretet.

Ajánlott tartalom (multiline):

```text
CLOUDFLARE_API_TOKEN=xxxx
CLOUDFLARE_ZONE_ID=yyyy
```

JSON formátum is támogatott:

```json
{"CLOUDFLARE_API_TOKEN":"xxxx","CLOUDFLARE_ZONE_ID":"yyyy"}
```

## 6. Ellenőrzés

Deploy után:

```bash
docker compose ps
docker compose logs backend --tail=100
docker compose logs frontend --tail=100
docker compose logs db --tail=100
```

## 7. Tipikus hibák

- `Docker daemon nem elérhető`: a user nincs a `docker` csoportban, vagy nem fut a docker service.
- `Env fájl nem található`: hiányzik a `.env.docker` vagy rossz az `ENV_FILE_PATH`.
- `Compose fájl nem található`: rossz `DOCKER_COMPOSE_FILES` érték.
- `Permission denied` bind mappára: futtasd újra az install scriptet, vagy állíts ownershipot a runner userre.
