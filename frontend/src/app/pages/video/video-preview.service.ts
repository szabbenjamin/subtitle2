import { Injectable } from '@angular/core';
import { SubtitleCue } from './video.types';

@Injectable({ providedIn: 'root' })
export class VideoPreviewService {
  /**
   * SRT szöveg parse preview cue listává.
   * @param srtText SRT tartalom.
   * @returns Cue lista.
   */
  public parseSrtToCues(srtText : string) : SubtitleCue[] {
    const normalized : string = srtText.replace(/\r\n/g, '\n').trim();
    if (normalized.length === 0) {
      return [];
    }

    const blocks : string[] = normalized.split(/\n{2,}/);
    const cues : SubtitleCue[] = [];

    for (const block of blocks) {
      const lines : string[] = block.split('\n');
      if (lines.length < 2) {
        continue;
      }
      const timeLineIndex : number = lines[0].includes('-->') ? 0 : 1;
      const timeLine : string = lines[timeLineIndex] ?? '';
      const match : RegExpMatchArray | null = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
      );
      if (match === null) {
        continue;
      }

      const text : string = lines.slice(timeLineIndex + 1).join('\n').trim();
      if (text.length === 0) {
        continue;
      }

      cues.push({
        startSeconds: this.srtTimeToSeconds(match[1]),
        endSeconds: this.srtTimeToSeconds(match[2]),
        text,
      });
    }

    return cues;
  }

  /**
   * Aktív cue szöveg lekérése adott időpillanatra.
   * @param cues Cue lista.
   * @param currentTimeSeconds Aktuális videó idő.
   * @returns Aktív szöveg vagy üres string.
   */
  public findActiveText(cues : SubtitleCue[], currentTimeSeconds : number) : string {
    const activeCue : SubtitleCue | undefined = cues.find((cue : SubtitleCue) => {
      return currentTimeSeconds >= cue.startSeconds && currentTimeSeconds <= cue.endSeconds;
    });
    return activeCue?.text ?? '';
  }

  /**
   * SRT időbélyeg másodpercre.
   * @param value SRT idő.
   * @returns Másodperc.
   */
  private srtTimeToSeconds(value : string) : number {
    const normalized : string = value.replace(',', '.');
    const parts : string[] = normalized.split(':');
    if (parts.length !== 3) {
      return 0;
    }
    const hours : number = Number(parts[0]);
    const minutes : number = Number(parts[1]);
    const seconds : number = Number(parts[2]);
    if (Number.isFinite(hours) === false || Number.isFinite(minutes) === false || Number.isFinite(seconds) === false) {
      return 0;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }
}
