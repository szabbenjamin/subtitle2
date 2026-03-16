import { BadRequestException, Injectable } from '@nestjs/common';
import { basename, extname, join } from 'path';
import { execFile } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { SubtitlePresetEntity } from '../subtitle-presets/entities/subtitle-preset.entity';
import { VideoEntity } from './entities/video.entity';

export interface ExportedVideoFile {
  filePath : string;
  fileName : string;
}

@Injectable()
export class VideoExportService {
  /**
   * ASS generálás + ffmpeg beégetés és export útvonal visszaadása.
   * @param ownerId User azonosító.
   * @param video Videó entitás.
   * @param preset Kiválasztott sablon.
   * @param uploadsDir Feltöltési könyvtár.
   * @returns Elkészült videófájl.
   */
  public async exportBurnedVideo(
    ownerId : number,
    video : VideoEntity,
    preset : SubtitlePresetEntity,
    uploadsDir : string,
  ) : Promise<ExportedVideoFile> {
    const subtitleText : string = video.subtitleText.trim();
    if (subtitleText.length === 0) {
      throw new BadRequestException('Nincs mentett felirat, nem exportálható videó.');
    }

    const inputPath : string = join(uploadsDir, video.storageFileName);
    const exportDir : string = join(process.cwd(), 'data', 'exports', String(ownerId));
    await mkdir(exportDir, { recursive: true });

    const safeBaseName : string = basename(video.originalFileName, extname(video.originalFileName))
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const stamp : string = String(Date.now());
    const assPath : string = join(exportDir, `${safeBaseName}-${video.id}-${stamp}.ass`);
    const outputPath : string = join(exportDir, `${safeBaseName}-${video.id}-${stamp}.mp4`);
    const outputFileName : string = `${safeBaseName}-subtitled.mp4`;

    const assContent : string = this.buildAssFileContent(video, preset);
    await writeFile(assPath, assContent, 'utf8');
    await this.runFfmpegBurn(inputPath, assPath, outputPath);

    return {
      filePath: outputPath,
      fileName: outputFileName,
    };
  }

  /**
   * ASS fájl tartalom építése az SRT és sablon adatok alapján.
   */
  private buildAssFileContent(video : VideoEntity, preset : SubtitlePresetEntity) : string {
    const bold : number = preset.bold ? 1 : 0;
    const italic : number = preset.italic ? 1 : 0;
    const underline : number = preset.underline ? 1 : 0;
    const strikeOut : number = preset.strikeOut ? 1 : 0;

    const assLines : string[] = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'Collisions: Normal',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      `Style: Default,${preset.fontName},${preset.fontSize},${this.hexToAegisubColor(preset.primaryColour)},${this.hexToAegisubColor(preset.secondaryColour)},${this.hexToAegisubColor(preset.outlineColour)},&H80000000,${bold},${italic},${underline},${strikeOut},${preset.scaleX},${preset.scaleY},${preset.spacing},${preset.angle},${preset.borderStyle},${preset.outline},${preset.shadow},${preset.alignment},${preset.marginL},${preset.marginR},${preset.marginV},${preset.encoding}`,
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ];

    const subtitleEvents : Array<{ start : string; end : string; text : string }> = this.parseSrtEvents(video.subtitleText);
    if (subtitleEvents.length === 0) {
      const endSeconds : number = Math.max(1, video.durationSeconds);
      const plainText : string = this.escapeAssText(video.subtitleText).replace(/\n/g, '\\N');
      assLines.push(`Dialogue: 0,0:00:00.00,${this.secondsToAssTime(endSeconds)},Default,,0,0,0,,${plainText}`);
      return `${assLines.join('\n')}\n`;
    }

    for (const event of subtitleEvents) {
      assLines.push(`Dialogue: 0,${event.start},${event.end},Default,,0,0,0,,${event.text}`);
    }

    return `${assLines.join('\n')}\n`;
  }

  /**
   * SRT szöveg ASS eseményekké alakítása.
   */
  private parseSrtEvents(subtitleText : string) : Array<{ start : string; end : string; text : string }> {
    const normalized : string = subtitleText.replace(/\r\n/g, '\n');
    const blocks : string[] = normalized.split(/\n{2,}/).map((block : string) => block.trim()).filter((block : string) => block.length > 0);
    const events : Array<{ start : string; end : string; text : string }> = [];

    for (const block of blocks) {
      const lines : string[] = block.split('\n');
      if (lines.length < 2) {
        continue;
      }

      const timeLineIndex : number = lines[0].includes('-->') ? 0 : 1;
      const timeLine : string = lines[timeLineIndex] ?? '';
      const timeMatch : RegExpMatchArray | null = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
      );
      if (timeMatch === null) {
        continue;
      }

      const textLines : string[] = lines.slice(timeLineIndex + 1);
      const rawText : string = textLines.join('\n').trim();
      if (rawText.length === 0) {
        continue;
      }

      events.push({
        start: this.srtTimeToAssTime(timeMatch[1]),
        end: this.srtTimeToAssTime(timeMatch[2]),
        text: this.escapeAssText(rawText).replace(/\n/g, '\\N'),
      });
    }

    return events;
  }

  /**
   * SRT időbélyeg ASS formátumra konvertálása.
   */
  private srtTimeToAssTime(value : string) : string {
    const normalized : string = value.replace(',', '.');
    const match : RegExpMatchArray | null = normalized.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})/);
    if (match === null) {
      return '0:00:00.00';
    }

    const hours : number = Number(match[1]);
    const minutes : number = Number(match[2]);
    const seconds : number = Number(match[3]);
    const milliseconds : number = Number(match[4].padEnd(3, '0'));
    const totalMilliseconds : number = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds;
    return this.millisecondsToAssTime(totalMilliseconds);
  }

  /**
   * Másodperc ASS időformátumra.
   */
  private secondsToAssTime(seconds : number) : string {
    const totalMilliseconds : number = Math.max(0, Math.round(seconds * 1_000));
    return this.millisecondsToAssTime(totalMilliseconds);
  }

  /**
   * Milliszekundum ASS időformátumra.
   */
  private millisecondsToAssTime(totalMilliseconds : number) : string {
    const safeMs : number = Math.max(0, totalMilliseconds);
    const hours : number = Math.floor(safeMs / 3_600_000);
    const minutes : number = Math.floor((safeMs % 3_600_000) / 60_000);
    const seconds : number = Math.floor((safeMs % 60_000) / 1_000);
    const centiseconds : number = Math.floor((safeMs % 1_000) / 10);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  }

  /**
   * HTML hex szín ASS/Aegisub színformátumra konvertálása.
   */
  private hexToAegisubColor(hexColor : string) : string {
    const match : RegExpMatchArray | null = hexColor.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (match === null) {
      return '&H00FFFFFF';
    }
    const rgb : string = match[1].toUpperCase();
    const rr : string = rgb.slice(0, 2);
    const gg : string = rgb.slice(2, 4);
    const bb : string = rgb.slice(4, 6);
    return `&H00${bb}${gg}${rr}`;
  }

  /**
   * ASS szöveg escape.
   */
  private escapeAssText(text : string) : string {
    return text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
  }

  /**
   * ffmpeg futtatása az ASS beégetéshez.
   */
  private async runFfmpegBurn(inputPath : string, assPath : string, outputPath : string) : Promise<void> {
    const subtitleFilter : string = `ass=${assPath.replace(/\\/g, '/')}`;
    await new Promise<void>((resolve : () => void, reject : (error : Error) => void) => {
      execFile(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vf',
          subtitleFilter,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outputPath,
        ],
        { timeout: 0 },
        (error : Error | null, stdout : string, stderr : string) => {
          if (error !== null) {
            const details : string = `${stdout}\n${stderr}`.trim();
            reject(new Error(`A videó exportálása sikertelen: ${details}`));
            return;
          }
          resolve();
        },
      );
    });
  }
}
