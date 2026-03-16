import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSubtitlePresetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name !: string;
}
