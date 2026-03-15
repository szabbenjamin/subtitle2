import { IsString } from 'class-validator';

export class UpdateSubtitleDto {
  @IsString()
  public subtitleText !: string;
}
