import { isAllowedMediaExtension, isAllowedMediaMimeType } from './video-file-validation.util';

describe('video-file-validation util', () => {
  it('accepts supported video/audio extensions (case-insensitive)', () => {
    expect(isAllowedMediaExtension('movie.MP4')).toBe(true);
    expect(isAllowedMediaExtension('track.m4a')).toBe(true);
    expect(isAllowedMediaExtension('clip.webm')).toBe(true);
  });

  it('rejects unsupported or missing extensions', () => {
    expect(isAllowedMediaExtension('document.pdf')).toBe(false);
    expect(isAllowedMediaExtension('filename-without-extension')).toBe(false);
    expect(isAllowedMediaExtension('')).toBe(false);
  });

  it('accepts video/* and audio/* mime types', () => {
    expect(isAllowedMediaMimeType('video/mp4')).toBe(true);
    expect(isAllowedMediaMimeType('audio/mpeg')).toBe(true);
    expect(isAllowedMediaMimeType('  VIDEO/WEBM  ')).toBe(true);
  });

  it('rejects non-media mime types or undefined', () => {
    expect(isAllowedMediaMimeType('application/json')).toBe(false);
    expect(isAllowedMediaMimeType('text/plain')).toBe(false);
    expect(isAllowedMediaMimeType(undefined)).toBe(false);
  });
});
