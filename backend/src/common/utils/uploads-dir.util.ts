import { isAbsolute, join } from 'path';

/**
 * Feltöltési könyvtár abszolút útvonalának előállítása.
 * @param rawDir Környezeti változóban megadott útvonal.
 * @returns Abszolút könyvtárútvonal.
 */
export function resolveUploadsDir(rawDir : string | undefined) : string {
  const configured : string = rawDir ?? 'uploads';
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}
