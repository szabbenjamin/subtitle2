import { IsBoolean } from 'class-validator';

export class UpdateHiddenDto {
  @IsBoolean()
  public hidden !: boolean;
}
