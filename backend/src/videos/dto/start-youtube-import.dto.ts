import { IsString, MinLength } from 'class-validator';

export class StartYoutubeImportDto {
  @IsString()
  @MinLength(1)
  public url !: string;
}
