import { IsInt, Min } from 'class-validator';

export class SetUserBalanceDto {
  @IsInt()
  @Min(0)
  public tokenBalance !: number;
}
