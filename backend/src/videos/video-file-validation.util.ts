const ALLOWED_MEDIA_EXTENSIONS : ReadonlySet<string> = new Set<string>([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
]);

/**
 * Ellenőrzi, hogy a fájlnév kiterjesztése támogatott video/audio típus-e.
 */
export function isAllowedMediaExtension(fileName : string) : boolean {
  const normalizedName : string = fileName.trim().toLowerCase();
  const dotIndex : number = normalizedName.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  const extension : string = normalizedName.slice(dotIndex);
  return ALLOWED_MEDIA_EXTENSIONS.has(extension);
}

/**
 * Ellenőrzi, hogy a MIME video/* vagy audio/*.
 */
export function isAllowedMediaMimeType(mimeType : string | undefined) : boolean {
  if (mimeType === undefined) {
    return false;
  }
  const normalized : string = mimeType.trim().toLowerCase();
  return normalized.startsWith('video/') || normalized.startsWith('audio/');
}
