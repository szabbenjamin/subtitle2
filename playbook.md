# Következő App Playbook (Angular + PWA + CI/CD + Self-Hosted Runner)

Ez a dokumentum azt foglalja össze, hogyan jutottunk el ennél a projektnél a működő Angular/PWA alkalmazásig, és hogyan lehet ezt a mintát új, más tematikájú appnál újrahasználni.

## 1. Projekt alapok (Angular)
### 1.1 Kiindulás

- Angular standalone komponens alapú struktúrát használtunk.
- A fő konténer (`AppComponent`) orchestrálja az állapotot.
- UI részek külön komponensekbe lettek szervezve.

### 1.2 Struktúra

- UI komponensek: `src/app/components/...`
- Szolgáltatások: `src/app/services/...`
- Konfiguráció: `src/app/config/...`

### 1.3 Ajánlott mintázat új apphoz

1. Először monolitikusan készítsd el az első működő verziót.
2. Utána refaktoráld szét:
   - konténer komponens: állapot + események,
   - prezentációs komponensek: csak Input/Output.
3. Keresztmetszeti logikát emelj service-be:
   - theme, sötét, világod mód, legyen gomb amivel amúgyis lehet váltogatni a kettő között és localstorage-be mentse el az állapotot
   - persistence (localStorage), indexedDB
   - háttéridőzítők / karbantartó logika.

## 2. PWA beállítás
### 2.1 Manifest és ikonok

- `public/manifest.webmanifest` tartalmazza az ikonok listáját.
- Ikonok a `public/icons/` mappában vannak.
- `src/index.html` tartalmaz:
  - favicon hivatkozásokat,
  - `apple-touch-icon`,
  - manifest linket.

### 2.2 Ikongenerálás SVG-ből

- Forrás képfájlt a felhasználó megadja, méretezd át

### 2.3 PWA cache frissítés mobilon

- Ikonváltoztatás után a mobil OS erősen cache-elhet.

### 2.4 PWA telepítési sáv elvárás

- Az oldal alján jelenjen meg egy kompakt kinézetű telepítési sáv, ha:
  - az app még nincs telepítve,
  - a böngésző jelzi, hogy telepíthető (`beforeinstallprompt`).
- A sáv legyen bezárható (`X`).
- Bezárás után legalább 1 napig ne jelenjen meg újra.
- A bezárási időbélyeg localStorage-ben legyen tárolva.

## 3. SEO alapcsomag
### 3.1 Kötelező elemek

- `src/index.html` fej részben:
  - `meta description`,
  - `meta robots`,
  - Open Graph (`og:*`) tagek,
  - Twitter (`twitter:*`) tagek,
  - `canonical` link,
  - `hreflang` linkek.

### 3.2 Technikai SEO fájlok

- `public/robots.txt`
  - `Allow: /`
  - `Sitemap: https://<domain>/sitemap.xml`
- `public/sitemap.xml`
  - fő URL(ek),
  - `lastmod`, `changefreq`, `priority`.

### 3.3 Strukturált adatok (JSON-LD)

- `WebSite` és `Organization` schema ajánlott.
- A JSON-LD script mehet közvetlenül az `index.html` `<head>` részébe.

### 3.4 Domain-csere ellenőrzőlista

Minden `example.com` placeholdert cserélj a valós domainre:

1. `canonical`
2. `og:url`
3. `og:image`
4. `twitter:image`
5. JSON-LD `url`/`logo`
6. `robots.txt` sitemap URL
7. `sitemap.xml` `<loc>`

### 3.5 Domain megerősítési szabály

- Ha a publikus domain nincs egyértelműen megadva, kötelező rákérdezni a felhasználónál.
- Domain megerősítés nélkül ne maradjon placeholder (`example.com`) SEO vagy strukturált adat mezőben.

## 4. Konfigurációkezelés (lokális/szerver-specifikus)
### 4.1 Minta

- Példa fájl verziózott:
  - `src/app/config/config.sample.ts`
- Éles, szerver-specifikus fájl:
  - `src/app/config/config.ts`

### 4.2 Git stratégia

- A valódi config mehet `.gitignore`-ba.
- Fontos: CI checkout/deploy ne törölje a szerveren meglévő configot.

## 5. CI/CD (GitHub Actions) minta
### 5.1 Workflow

- Fájl: `.github/workflows/selfhosted-cicd.yml`
- Trigger:
  - `push` `main`/`master`,
  - `workflow_dispatch`.
- Lépések:
  1. checkout,
  2. Node telepítés,
  3. `npm ci`,
  4. `npm run build`,
  5. deploy script futtatás.

### 5.2 Deploy script

- Fájl: `scripts/deploy-selfhosted.sh`
- `rsync --delete` alapú deploy.
- Külön megőrzött fájlok listája (nem törlődnek deploy alatt), pl:
  - `config.ts`.

## 6. Self-hosted GitHub Action runner létrehozása
### 6.1 Runner letöltés és konfigurálás

```bash
./config.sh \
  --url https://github.com/<owner>/<repo> \
  --token <REGISTRATION_TOKEN> \
  --name <runner-nev> \
  --labels self-hosted,linux \
  --work _work \
  --unattended \
  --replace
```

Megjegyzés:
- A workflow `runs-on` címkéinek egyezniük kell a runner labeljeivel.

### 6.2 Runner telepítése service-ként

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

Hasznos:

```bash
sudo ./svc.sh stop
sudo ./svc.sh uninstall
```

### 6.3 Jogosultság a deployhoz (`/var/www/html`)

Két tipikus út:

1. `winben` közvetlen írásjogot kap a célmappára.
2. `sudo` használat csak `rsync`-re NOPASSWD-val.

Sudoers példa:

```text
winben ALL=(root) NOPASSWD:/usr/bin/rsync
```

Ellenőrzés:

```bash
sudo -n /usr/bin/rsync --version
```

### 6.4 `winben` felhasználó létrehozása + sudoer + NOPASSWD (egylépéses)

Az alábbi parancsot rootként (vagy sudo jogosultságú userrel) futtasd a célszerveren.  
Létrehozza a `winben` felhasználót (ha még nem létezik), hozzáadja a `sudo` csoporthoz, és teljes jelszó nélküli sudo jogot ad.

```bash
sudo bash -c 'id -u winben >/dev/null 2>&1 || useradd -m -s /bin/bash winben; usermod -aG sudo winben; printf "winben ALL=(ALL) NOPASSWD:ALL\n" > /etc/sudoers.d/99-winben-nopasswd; chmod 440 /etc/sudoers.d/99-winben-nopasswd; visudo -cf /etc/sudoers.d/99-winben-nopasswd'
```

Ellenőrzés:

```bash
sudo -l -U winben
```

## 7. Fontos üzemeltetési megjegyzések

- A self-hosted runner checkoutja törölheti az untracked fájlokat, ha a workflow így van beállítva.
- Ha lokális szerver-configot meg akarsz tartani, a checkout/deploy lépéseket ehhez kell igazítani.
- Éles deploy előtt mindig:
  - `npm run build`
  - jogok és megőrzendő fájlok ellenőrzése.

### 7.1 Fejlesztés ellenőrzése SSH tunnellel

Ha a fejlesztői szerveren fut az Angular app (`ng serve`, tipikusan `localhost:4200`), lokálról így tudod biztonságosan elérni:

```bash
ssh -L 4200:localhost:4200 -C -N -l winben 192.168.0.82
```

Ezután a helyi böngészőben a `http://localhost:4200` címen éred el a távoli fejlesztői példányt.

## 8. Ajánlott induló checklist új apphoz

1. Angular scaffold + standalone komponens struktúra.
2. PWA bekapcsolás, manifest + ikon pipeline.
3. SEO alapcsomag (meta/OG/Twitter/canonical/robots/sitemap/JSON-LD).
4. Konfig stratégia: sample + local/ignored.
5. CI build pipeline.
6. Deploy script megőrzési szabályokkal.
7. Self-hosted runner service és jogosultságok.
8. E2E ellenőrzés: build, deploy, megőrzött fájlok, mobil PWA install.
