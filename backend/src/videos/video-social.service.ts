import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoEntity } from './entities/video.entity';

export interface SocialTextResult {
  title : string;
  hashtags : string[];
  combinedText : string;
}

@Injectable()
export class VideoSocialService {
  public constructor(private readonly configService : ConfigService) {}

  /**
   * Cím + hashtag lista generálása a videó szövegkönyvéből.
   * @param video Videó entitás.
   * @returns Generált cím és hashtag-ek.
   */
  public async generateFromSubtitle(video : VideoEntity) : Promise<SocialTextResult> {
    const cleanText : string = this.extractPlainText(video.subtitleText);
    if (cleanText.length === 0) {
      throw new BadRequestException('Nincs szövegkönyv, nem generálható cím és hashtag.');
    }

    const apiKey : string = (this.configService.get<string>('OPENAI_API_KEY') ?? '').trim();
    if (apiKey.length === 0) {
      throw new InternalServerErrorException('OPENAI_API_KEY nincs beállítva a backend .env fájlban.');
    }

    const model : string = (this.configService.get<string>('OPENAI_MODEL') ?? 'gpt-3.5-turbo').trim();
    const timeoutMs : number = Number(this.configService.get<string>('OPENAI_TIMEOUT_MS') ?? '25000');

    const controller : AbortController = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response : Response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Magyar nyelvű közösségi média meta szöveget készítesz. Csak JSON objektumot adj vissza: {"title":"...","hashtags":["#tag1","#tag2"]}. A cím legyen maximum 90 karakter. A hashtag lista 5-8 elem legyen.',
            },
            {
              role: 'user',
              content: `Készíts címet és hashtag-eket az alábbi szövegkönyvből:\n\n${cleanText}`,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (response.ok === false) {
        const errorText : string = await response.text();
        throw new InternalServerErrorException(`OpenAI API hiba: ${errorText}`);
      }

      const payload : unknown = await response.json();
      const content : string = this.extractAssistantContent(payload);
      const parsed : SocialTextResult = this.parseSocialJson(content);
      const normalizedHashtags : string[] = this.normalizeHashtags(parsed.hashtags);
      const normalizedTitle : string = this.normalizeTitle(parsed.title);
      return {
        title: normalizedTitle,
        hashtags: normalizedHashtags,
        combinedText: `${normalizedTitle}\n\n${normalizedHashtags.join(' ')}`.trim(),
      };
    } catch (error : unknown) {
      if (error instanceof InternalServerErrorException || error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`OpenAI kérés sikertelen: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * SRT-ből tiszta szöveg kinyerése.
   */
  private extractPlainText(subtitleText : string) : string {
    const lines : string[] = subtitleText.replace(/\r\n/g, '\n').split('\n');
    const cleaned : string[] = [];

    for (const rawLine of lines) {
      const line : string = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      if (/^\d+$/.test(line)) {
        continue;
      }
      if (/^\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(line)) {
        continue;
      }
      cleaned.push(line);
    }

    return cleaned.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Cím normalizálása publikálható hosszra.
   */
  private normalizeTitle(title : string) : string {
    const cleaned : string = title.replace(/["'`]+/g, '').trim();
    if (cleaned.length <= 90) {
      return this.capitalize(cleaned);
    }
    return `${this.capitalize(cleaned.slice(0, 87).trimEnd())}...`;
  }

  private extractAssistantContent(payload : unknown) : string {
    if (typeof payload !== 'object' || payload === null) {
      throw new InternalServerErrorException('OpenAI válaszformátum hiba.');
    }
    const choices : unknown = (payload as { choices ?: unknown }).choices;
    if (Array.isArray(choices) === false || choices.length === 0) {
      throw new InternalServerErrorException('OpenAI válasz nem tartalmaz choices tömböt.');
    }
    const firstChoice : unknown = choices[0];
    const message : unknown = (firstChoice as { message ?: unknown }).message;
    const content : unknown = (message as { content ?: unknown })?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new InternalServerErrorException('OpenAI válasz nem tartalmaz értelmezhető content mezőt.');
    }
    return content;
  }

  private parseSocialJson(content : string) : SocialTextResult {
    let parsed : unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new InternalServerErrorException('OpenAI válasz nem érvényes JSON.');
    }

    const title : unknown = (parsed as { title ?: unknown }).title;
    const hashtags : unknown = (parsed as { hashtags ?: unknown }).hashtags;
    if (typeof title !== 'string') {
      throw new InternalServerErrorException('OpenAI JSON válaszban hiányzik a title.');
    }
    if (Array.isArray(hashtags) === false) {
      throw new InternalServerErrorException('OpenAI JSON válaszban hiányzik a hashtags tömb.');
    }

    return {
      title,
      hashtags: hashtags.filter((item : unknown) => typeof item === 'string') as string[],
      combinedText: '',
    };
  }

  private normalizeHashtags(hashtags : string[]) : string[] {
    const cleaned : string[] = hashtags
      .map((tag : string) => tag.trim())
      .filter((tag : string) => tag.length > 0)
      .map((tag : string) => (tag.startsWith('#') ? tag : `#${tag}`))
      .map((tag : string) => `#${tag.slice(1).replace(/[^a-zA-Z0-9áéíóöőúüű]/g, '')}`)
      .filter((tag : string) => tag.length > 1);

    const unique : string[] = Array.from(new Set<string>(cleaned));
    if (unique.length === 0) {
      return ['#subtitle2', '#video'];
    }
    return unique.slice(0, 8);
  }

  private capitalize(value : string) : string {
    if (value.length === 0) {
      return value;
    }
    return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  }
}
