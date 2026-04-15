# Fresh Production Server TODO (subtitle2)

Ez egy gyakorlati checklist friss Ubuntu 24.04 szerverhez.

## 1. Alap szerver elokeszites

- [ ] Frissites:
  ```bash
  sudo apt-get update && sudo apt-get upgrade -y
  ```
- [ ] Hozz letre egy deploy usert (ha nincs):
  ```bash
  sudo adduser winben
  sudo usermod -aG sudo winben
  ```
- [ ] SSH hardening:
  - [ ] kulcsos belepes
  - [ ] root login tiltasa
  - [ ] jelszavas login tiltasa
- [ ] Firewall (minimum):
  ```bash
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw enable
  ```

## 2. Repo letoltes

- [ ] Klonozd a projektet:
  ```bash
  git clone <REPO_URL> subtitle2
  cd subtitle2
  ```
- [ ] Valts a hasznalt branchre:
  ```bash
  git checkout main
  ```

## 3. Env file elokeszitese

- [ ] Keszitsd elo az env file-t:
  ```bash
  cp .env.docker.example .env.docker
  ln -sfn .env.docker .env
  ```
- [ ] Toltsd ki legalabb ezeket valos ertekekkel:
  - [ ] `MYSQL_ROOT_PASSWORD`
  - [ ] `MYSQL_PASSWORD`
  - [ ] `JWT_SECRET`
  - [ ] `OPENAI_API_KEY`
  - [ ] `SMTP_USER`
  - [ ] `SMTP_PASS`
  - [ ] `FRONTEND_BASE_URL`
  - [ ] `MYSQL_DATA_DIR`, `BACKEND_UPLOADS_DIR`, `BACKEND_DATA_DIR`, `WHISPER_CACHE_DIR` (abszolut path ajanlott)

## 4. Full installer futtatasa

- [ ] Futtasd a friss szerver bootstrap scriptet:
  ```bash
  TARGET_USER=winben \
  ENV_FILE_PATH=.env.docker \
  AUTO_DEPLOY=true \
  bash scripts/install-fresh-production.sh
  ```

Megjegyzes:
- Ha a `TARGET_USER` meg nem letezik, a script alapbol letrehozza (`CREATE_TARGET_USER=true`).
- Ha nem akarod, hogy azonnal deployoljon: `AUTO_DEPLOY=false`.

## 5. Github Actions self-hosted runner (ha kell CI/CD deploy)

- [ ] Szerezz registration tokent a GitHub repo Settings / Actions / Runners feluleten.
- [ ] Futtasd ujra az installert runner parameterekkel:
  ```bash
  TARGET_USER=winben \
  ENV_FILE_PATH=.env.docker \
  RUNNER_URL="https://github.com/<owner>/<repo>" \
  RUNNER_TOKEN="<registration-token>" \
  bash scripts/install-selfhosted.sh
  ```

## 6. Github secret-ek

- [ ] `ENV_DOCKER` secret: a teljes `.env.docker` tartalma (multiline).
- [ ] `CF_CACHE_PURGE` secret opcionális:
  ```text
  CLOUDFLARE_API_TOKEN=xxxx
  CLOUDFLARE_ZONE_ID=yyyy
  ```

## 7. Mukodes ellenorzese

- [ ] Kontenerek allapota:
  ```bash
  docker compose --env-file .env.docker -f docker-compose.yml ps
  ```
- [ ] Backend log:
  ```bash
  docker compose --env-file .env.docker -f docker-compose.yml logs backend --tail=100
  ```
- [ ] Frontend log:
  ```bash
  docker compose --env-file .env.docker -f docker-compose.yml logs frontend --tail=100
  ```
- [ ] DB log:
  ```bash
  docker compose --env-file .env.docker -f docker-compose.yml logs db --tail=100
  ```
- [ ] API smoke test:
  ```bash
  curl -i http://127.0.0.1:3000/api/auth/me
  ```

## 8. Backup es uzemeltetes minimum

- [ ] Napi MySQL dump cron.
- [ ] `BACKEND_UPLOADS_DIR`, `BACKEND_DATA_DIR`, `WHISPER_CACHE_DIR` backup policy.
- [ ] Logrotacio / monitorozas beallitasa.
- [ ] Rendszeres `docker system prune` policy (kontrollaltan).

## 9. Frissitesi rutin

- [ ] Kod frissites:
  ```bash
  git pull
  ```
- [ ] Kezi deploy:
  ```bash
  bash scripts/deploy-selfhosted.sh
  ```
