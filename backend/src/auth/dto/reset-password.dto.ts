import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  public token !: string;

  @IsString()
  @MinLength(8)
  public newPassword !: string;
}
