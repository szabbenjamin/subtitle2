import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';

export class ExportHighlightClipItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public clipId !: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  public startSeconds ?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  public endSeconds ?: number;
}

export class ExportHighlightClipsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExportHighlightClipItemDto)
  public clips !: ExportHighlightClipItemDto[];
}
