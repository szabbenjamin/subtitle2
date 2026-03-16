import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../common/interfaces/auth-user.interface';
import { CreateSubtitlePresetDto } from './dto/create-subtitle-preset.dto';
import { UpdateSubtitlePresetDto } from './dto/update-subtitle-preset.dto';
import { SubtitlePresetDto, SubtitlePresetsService } from './subtitle-presets.service';

@Controller('subtitle-presets')
@UseGuards(JwtAuthGuard)
export class SubtitlePresetsController {
  public constructor(private readonly subtitlePresetsService : SubtitlePresetsService) {}

  /**
   * Bejelentkezett felhasználó sablonjai.
   * @param user Bejelentkezett user.
   * @returns Sablon lista.
   */
  @Get()
  public async list(@CurrentUser() user : AuthUser) : Promise<SubtitlePresetDto[]> {
    return await this.subtitlePresetsService.list(user.id);
  }

  /**
   * Új sablon létrehozása.
   * @param user Bejelentkezett user.
   * @param dto Létrehozási adatok.
   * @returns Létrejött sablon.
   */
  @Post()
  public async create(@CurrentUser() user : AuthUser, @Body() dto : CreateSubtitlePresetDto) : Promise<SubtitlePresetDto> {
    return await this.subtitlePresetsService.create(user.id, dto);
  }

  /**
   * Sablon módosítása.
   * @param user Bejelentkezett user.
   * @param id Sablon azonosító.
   * @param dto Frissítési adatok.
   * @returns Frissített sablon.
   */
  @Patch(':id')
  public async update(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : UpdateSubtitlePresetDto,
  ) : Promise<SubtitlePresetDto> {
    return await this.subtitlePresetsService.update(user.id, id, dto);
  }

  /**
   * Sablon törlése.
   * @param user Bejelentkezett user.
   * @param id Sablon azonosító.
   * @returns Siker jelzés.
   */
  @Delete(':id')
  public async remove(@CurrentUser() user : AuthUser, @Param('id', ParseIntPipe) id : number) : Promise<{ success : boolean }> {
    return await this.subtitlePresetsService.remove(user.id, id);
  }
}
