import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateSubtitlePresetDto } from './dto/create-subtitle-preset.dto';
import { UpdateSubtitlePresetDto } from './dto/update-subtitle-preset.dto';
import { SubtitlePresetEntity } from './entities/subtitle-preset.entity';

export interface SubtitlePresetDto {
  id : number;
  name : string;
  fontName : string;
  fontSize : number;
  primaryColour : string;
  secondaryColour : string;
  outlineColour : string;
  backColour : string;
  bold : boolean;
  italic : boolean;
  underline : boolean;
  strikeOut : boolean;
  scaleX : number;
  scaleY : number;
  spacing : number;
  angle : number;
  borderStyle : number;
  outline : number;
  shadow : number;
  alignment : number;
  marginL : number;
  marginR : number;
  marginV : number;
  encoding : string;
  createdAt : Date;
  updatedAt : Date;
}

@Injectable()
export class SubtitlePresetsService {
  public constructor(
    @InjectRepository(SubtitlePresetEntity)
    private readonly presetsRepository : Repository<SubtitlePresetEntity>,
  ) {}

  /**
   * Felhasználó sablonjainak lekérése.
   * @param ownerId User azonosító.
   * @returns Rendezett sablon lista.
   */
  public async list(ownerId : number) : Promise<SubtitlePresetDto[]> {
    const presets : SubtitlePresetEntity[] = await this.presetsRepository.find({
      where: { ownerId },
      order: { updatedAt: 'DESC' },
    });
    return presets.map((preset : SubtitlePresetEntity) => this.toDto(preset));
  }

  /**
   * Új sablon létrehozása alapértékekkel.
   * @param ownerId User azonosító.
   * @param dto Létrehozási adatok.
   * @returns Létrejött sablon.
   */
  public async create(ownerId : number, dto : CreateSubtitlePresetDto) : Promise<SubtitlePresetDto> {
    const created : SubtitlePresetEntity = this.presetsRepository.create({
      ownerId,
      name: dto.name,
      fontName: 'Arial',
      fontSize: 56,
      primaryColour: '#FFFFFF',
      secondaryColour: '#000000',
      outlineColour: '#000000',
      backColour: '#000000',
      bold: false,
      italic: false,
      underline: false,
      strikeOut: false,
      scaleX: 100,
      scaleY: 100,
      spacing: 0,
      angle: 0,
      borderStyle: 1,
      outline: 2,
      shadow: 2,
      alignment: 2,
      marginL: 30,
      marginR: 30,
      marginV: 30,
      encoding: 'UTF-8',
    });

    const saved : SubtitlePresetEntity = await this.presetsRepository.save(created);
    return this.toDto(saved);
  }

  /**
   * Sablon frissítése.
   * @param ownerId User azonosító.
   * @param id Sablon azonosító.
   * @param dto Frissítési adatok.
   * @returns Frissített sablon.
   */
  public async update(ownerId : number, id : number, dto : UpdateSubtitlePresetDto) : Promise<SubtitlePresetDto> {
    const preset : SubtitlePresetEntity = await this.requireOwnedPreset(ownerId, id);
    Object.assign(preset, dto);
    const saved : SubtitlePresetEntity = await this.presetsRepository.save(preset);
    return this.toDto(saved);
  }

  /**
   * Sablon törlése.
   * @param ownerId User azonosító.
   * @param id Sablon azonosító.
   * @returns Siker jelzés.
   */
  public async remove(ownerId : number, id : number) : Promise<{ success : boolean }> {
    const preset : SubtitlePresetEntity = await this.requireOwnedPreset(ownerId, id);
    await this.presetsRepository.remove(preset);
    return { success: true };
  }

  /**
   * Ellenőrzi, hogy az adott sablon a userhez tartozik.
   * @param ownerId User azonosító.
   * @param id Sablon azonosító.
   * @returns Sablon entitás.
   */
  public async requireOwnedPreset(ownerId : number, id : number) : Promise<SubtitlePresetEntity> {
    const preset : SubtitlePresetEntity | null = await this.presetsRepository.findOne({
      where: {
        id,
        ownerId,
      },
    });

    if (preset === null) {
      throw new NotFoundException('A sablon nem található.');
    }

    return preset;
  }

  /**
   * Entity -> API DTO leképezés.
   * @param preset Sablon entitás.
   * @returns API DTO.
   */
  private toDto(preset : SubtitlePresetEntity) : SubtitlePresetDto {
    return {
      id: preset.id,
      name: preset.name,
      fontName: preset.fontName,
      fontSize: preset.fontSize,
      primaryColour: preset.primaryColour,
      secondaryColour: preset.secondaryColour,
      outlineColour: preset.outlineColour,
      backColour: preset.backColour,
      bold: preset.bold,
      italic: preset.italic,
      underline: preset.underline,
      strikeOut: preset.strikeOut,
      scaleX: preset.scaleX,
      scaleY: preset.scaleY,
      spacing: preset.spacing,
      angle: preset.angle,
      borderStyle: preset.borderStyle,
      outline: preset.outline,
      shadow: preset.shadow,
      alignment: preset.alignment,
      marginL: preset.marginL,
      marginR: preset.marginR,
      marginV: preset.marginV,
      encoding: preset.encoding,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
    };
  }
}
