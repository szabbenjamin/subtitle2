import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class UpdateWhisperSettingsDto {
  @IsString()
  @MinLength(1)
  public language !: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  public wordsPerLine !: number;
}
