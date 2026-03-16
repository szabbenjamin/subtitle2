import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateSubtitlePresetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name !: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public fontName !: string;

  @Type(() => Number)
  @IsInt()
  @Min(8)
  @Max(240)
  public fontSize !: number;

  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  public primaryColour !: string;

  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  public secondaryColour !: string;

  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  public outlineColour !: string;

  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  public backColour !: string;

  @Type(() => Boolean)
  @IsBoolean()
  public bold !: boolean;

  @Type(() => Boolean)
  @IsBoolean()
  public italic !: boolean;

  @Type(() => Boolean)
  @IsBoolean()
  public underline !: boolean;

  @Type(() => Boolean)
  @IsBoolean()
  public strikeOut !: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(300)
  public scaleX !: number;

  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(300)
  public scaleY !: number;

  @Type(() => Number)
  @IsInt()
  @Min(-40)
  @Max(80)
  public spacing !: number;

  @Type(() => Number)
  @IsInt()
  @Min(-360)
  @Max(360)
  public angle !: number;

  @Type(() => Number)
  @IsInt()
  @IsIn([1, 3, 4])
  public borderStyle !: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(24)
  public outline !: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(24)
  public shadow !: number;

  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4, 5, 6, 7, 8, 9])
  public alignment !: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  public marginL !: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  public marginR !: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  public marginV !: number;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  public encoding !: string;
}
