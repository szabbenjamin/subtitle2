import { IsString } from 'class-validator';

export class CompleteUploadDto {
  @IsString()
  public uploadId !: string;
}
