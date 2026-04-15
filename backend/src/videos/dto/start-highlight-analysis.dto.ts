import { IsIn, IsOptional, IsString } from 'class-validator';
import { HIGHLIGHT_MODE_VALUES } from '../video-highlights.pipeline';
import type { HighlightMode } from '../video-highlights.pipeline';

export class StartHighlightAnalysisDto {
  @IsOptional()
  @IsString()
  @IsIn(HIGHLIGHT_MODE_VALUES)
  public mode ?: HighlightMode;
}
