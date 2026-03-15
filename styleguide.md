# TypeScript Style Guide

Ez a projekt-specifikus kódolási szabálykészlet. Új és módosított kódnál ezeket kell követni.

## 1. Típusannotáció formátum

- A típusannotációnál a kettőspont előtt és után is legyen szóköz.
- Példa:
  - `const kiscica : number = 0;`
  - `public save(theme : AppTheme) : void { ... }`

## 2. Definite assignment (`!`) és opcionális (`?`) jelölés

- Definite assignment esetén:
  - `property !: Típus`
- Opcionális property esetén:
  - `property ?: Típus`

Példák:
- `public streamPlayer ?: ElementRef<HTMLAudioElement>;`
- `@Input() public currentTheme !: 'light' | 'dark';`

## 3. Láthatóság mindig legyen explicit

- Minden adattag és metódus kapjon explicit láthatósági módosítót:
  - `public` vagy `private` (szükség esetén `protected`)
- Constructor is legyen explicit:
  - `public constructor(...) { ... }`

## 4. `if` feltételek csak boolean kifejezéssel

- Ne használj implicit truthy/falsy vizsgálatot nem-boolean típusokon.
- Kerüld:
  - `if (!audio) { ... }`
  - `if (timer) { ... }`
- Használd:
  - `if (audio === undefined) { ... }`
  - `if (timer !== undefined) { ... }`
  - `if (savedPosition === null) { ... }`

## 5. Kommentek és dokumentáció

- Kommentek és JSDoc magyarul készüljenek.
- Minden metódus fölött legyen JSDoc.
- A JSDoc tartalmazza:
  - rövid leírást,
  - paramétereknél `@param`,
  - visszatérési értéknél `@returns` (ha releváns).

## 6. Objektum literal kulcsok

- Objektum literál kulcsainál normál JavaScript szintaxist használunk:
  - `key: value`
- Erre **nem** vonatkozik a típusannotációs szóköz szabály.

## 7. Érvényesítés

- Módosítás után kötelező build ellenőrzés:
  - `npm run build`
