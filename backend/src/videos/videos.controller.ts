import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import type { Response } from 'express';
import { mkdirSync } from 'fs';
import { createReadStream } from 'fs';
import { rm } from 'fs/promises';
import { extname } from 'path';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../common/interfaces/auth-user.interface';
import { resolveUploadsDir } from '../common/utils/uploads-dir.util';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { UpdateHiddenDto } from './dto/update-hidden.dto';
import { UpdateSubtitleDto } from './dto/update-subtitle.dto';
import { UploadChunkDto } from './dto/upload-chunk.dto';
import { UpdateVideoPresetDto } from './dto/update-video-preset.dto';
import { WhisperSettingsDto } from './dto/whisper-settings.dto';
import { InitUploadResponse, VideoDetails, VideoListItem, VideosService } from './videos.service';
import { ExportedVideoFile } from './video-export.service';
import { SocialTextResult } from './video-social.service';
import { isAllowedMediaExtension, isAllowedMediaMimeType } from './video-file-validation.util';

@Controller('videos')
@UseGuards(JwtAuthGuard)
export class VideosController {
  public constructor(private readonly videosService : VideosService) {}

  /**
   * Videólista lekérése látható vagy rejtett állapot szerint.
   * @param user Bejelentkezett user.
   * @param hidden Rejtett listát kérünk-e.
   * @returns Rendezett lista.
   */
  @Get()
  public async list(
    @CurrentUser() user : AuthUser,
    @Query('hidden', new ParseBoolPipe({ optional: true })) hidden ?: boolean,
  ) : Promise<VideoListItem[]> {
    const hiddenValue : boolean = hidden === true;
    return await this.videosService.list(user.id, hiddenValue);
  }

  /**
   * Egy videó részletes adatainak lekérése.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @returns Részletes videó adat.
   */
  @Get(':id')
  public async getById(@CurrentUser() user : AuthUser, @Param('id', ParseIntPipe) id : number) : Promise<VideoDetails> {
    return await this.videosService.getById(user.id, id);
  }

  /**
   * Videó törlése (adatbázis + feltöltött fájl).
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @returns Siker jelzés.
   */
  @Delete(':id')
  public async remove(@CurrentUser() user : AuthUser, @Param('id', ParseIntPipe) id : number) : Promise<{ success : boolean }> {
    return await this.videosService.remove(user.id, id);
  }

  /**
   * Új videó feltöltése.
   * @param user Bejelentkezett user.
   * @param file Feltöltött fájl.
   * @returns Létrejött videó rekord.
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (request : Express.Request, file : Express.Multer.File, callback : (error : Error | null, destination : string) => void) => {
          void request;
          void file;
          const uploadsDir : string = resolveUploadsDir(process.env.UPLOADS_DIR);
          mkdirSync(uploadsDir, { recursive: true });
          callback(null, uploadsDir);
        },
        filename: (request : Express.Request, file : Express.Multer.File, callback : (error : Error | null, filename : string) => void) => {
          void request;
          const extension : string = extname(file.originalname);
          const generated : string = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}${extension}`;
          callback(null, generated);
        },
      }),
      fileFilter: (
        request : Express.Request,
        file : Express.Multer.File,
        callback : (error : Error | null, acceptFile : boolean) => void,
      ) => {
        void request;
        const extensionAllowed : boolean = isAllowedMediaExtension(file.originalname);
        const mimeAllowed : boolean = isAllowedMediaMimeType(file.mimetype);
        if (extensionAllowed === false && mimeAllowed === false) {
          callback(new BadRequestException('Csak videó és hangfájl tölthető fel.'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  public async upload(@CurrentUser() user : AuthUser, @UploadedFile() file : Express.Multer.File) : Promise<VideoDetails> {
    if (file === undefined) {
      throw new BadRequestException('A fájl feltöltése kötelező.');
    }

    try {
      return await this.videosService.createFromUpload(user.id, file);
    } catch (error : unknown) {
      await rm(file.path, { force: true });
      throw error;
    }
  }

  /**
   * Chunkolt feltöltés inicializálása.
   * @param user Bejelentkezett user.
   * @param dto Feltöltés meta adatai.
   * @returns Feltöltési session.
   */
  @Post('upload/init')
  public async initUpload(@CurrentUser() user : AuthUser, @Body() dto : InitUploadDto) : Promise<InitUploadResponse> {
    return await this.videosService.initChunkedUpload(user.id, dto);
  }

  /**
   * Egy chunk feltöltése.
   * @param user Bejelentkezett user.
   * @param dto Chunk meta adatok.
   * @param file Feltöltött chunk adat.
   * @returns Siker jelzés.
   */
  @Post('upload/chunk')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: memoryStorage(),
      limits: {
        fileSize: 55 * 1024 * 1024,
      },
    }),
  )
  public async uploadChunk(
    @CurrentUser() user : AuthUser,
    @Body() dto : UploadChunkDto,
    @UploadedFile() file : Express.Multer.File,
  ) : Promise<{ success : boolean }> {
    if (file === undefined) {
      throw new BadRequestException('A chunk fájl kötelező.');
    }

    return await this.videosService.uploadChunk(user.id, dto, file);
  }

  /**
   * Chunkolt feltöltés lezárása és videó létrehozása.
   * @param user Bejelentkezett user.
   * @param dto Lezáró kérés adatai.
   * @returns Létrejött videó.
   */
  @Post('upload/complete')
  public async completeUpload(@CurrentUser() user : AuthUser, @Body() dto : CompleteUploadDto) : Promise<VideoDetails> {
    return await this.videosService.completeChunkedUpload(user.id, dto);
  }

  /**
   * Feltöltési session megszakítása és takarítása.
   * @param user Bejelentkezett user.
   * @param dto Megszakítás adatai.
   * @returns Siker jelzés.
   */
  @Post('upload/cancel')
  public async cancelUpload(@CurrentUser() user : AuthUser, @Body() dto : CompleteUploadDto) : Promise<{ success : boolean }> {
    return await this.videosService.cancelChunkedUpload(user.id, dto);
  }

  /**
   * Rejtett állapot frissítése.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @param dto Új rejtett állapot.
   * @returns Frissített videó.
   */
  @Patch(':id/hidden')
  public async updateHidden(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : UpdateHiddenDto,
  ) : Promise<VideoDetails> {
    return await this.videosService.updateHidden(user.id, id, dto.hidden);
  }

  /**
   * Felirat automatikus mentése.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @param dto Új feliratszöveg.
   * @returns Frissített videó.
   */
  @Patch(':id/subtitle')
  public async updateSubtitle(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : UpdateSubtitleDto,
  ) : Promise<VideoDetails> {
    return await this.videosService.updateSubtitle(user.id, id, dto.subtitleText);
  }

  /**
   * Videóhoz kiválasztott felirat sablon mentése.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @param dto Kiválasztott sablon.
   * @returns Frissített videó.
   */
  @Patch(':id/subtitle-preset')
  public async updateVideoPreset(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : UpdateVideoPresetDto,
  ) : Promise<VideoDetails> {
    return await this.videosService.updateVideoPreset(user.id, id, dto.presetId);
  }

  /**
   * Whisper beállítások mentése.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @param dto Whisper beállítások.
   * @returns Frissített videó.
   */
  @Patch(':id/whisper-settings')
  public async updateWhisperSettings(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : WhisperSettingsDto,
  ) : Promise<VideoDetails> {
    return await this.videosService.updateWhisperSettings(user.id, id, dto);
  }

  /**
   * Lehallgatási igény jelölése a háttérfolyamathoz.
   * @param user Bejelentkezett user.
   * @param id Videó ID.
   * @param dto Whisper paraméterek.
   * @returns Frissített videó.
   */
  @Post(':id/listen-request')
  public async requestListen(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : WhisperSettingsDto,
  ) : Promise<VideoDetails> {
    return await this.videosService.requestListenWithSettings(user.id, id, dto);
  }

  /**
   * Felirat beégetése ASS stílussal és letöltés indítása.
   * @param user Bejelentkezett user.
   * @param id Videó azonosító.
   * @param res HTTP válasz a letöltési headerekhez.
   * @returns Streamelhető videófájl.
   */
  @Post(':id/export')
  public async exportBurnedVideo(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Res({ passthrough: true }) res : Response,
  ) : Promise<StreamableFile> {
    const exportedFile : ExportedVideoFile = await this.videosService.exportBurnedVideo(user.id, id);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename=\"${exportedFile.fileName}\"`);
    const stream = createReadStream(exportedFile.filePath);
    return new StreamableFile(stream);
  }

  /**
   * Cím + hashtag generálása a jelenlegi szövegkönyvből.
   * @param user Bejelentkezett user.
   * @param id Videó azonosító.
   * @returns Generált cím és hashtag lista.
   */
  @Post(':id/social-text')
  public async generateSocialText(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
  ) : Promise<SocialTextResult> {
    return await this.videosService.generateSocialText(user.id, id);
  }
}
