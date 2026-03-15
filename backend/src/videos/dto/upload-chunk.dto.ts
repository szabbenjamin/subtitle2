import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';

export class UploadChunkDto {
  @IsString()
  public uploadId !: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  public chunkIndex !: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public totalChunks !: number;
}
