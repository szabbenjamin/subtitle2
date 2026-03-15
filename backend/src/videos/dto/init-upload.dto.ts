import { Type } from 'class-transformer';
import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class InitUploadDto {
  @IsString()
  @MinLength(1)
  public originalFileName !: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  public fileSizeBytes !: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public totalChunks !: number;
}
