import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateHighlightFeedbackDto {
  @IsBoolean()
  public isAccurate !: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public note ?: string;
}
