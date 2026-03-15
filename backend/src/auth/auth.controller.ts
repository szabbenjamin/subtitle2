import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../common/interfaces/auth-user.interface';
import { AuthService, AuthTokenResponse, SafeUserResponse } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  public constructor(private readonly authService : AuthService) {}

  /**
   * Regisztráció email + jelszó párossal.
   * @param dto Regisztrációs adatok.
   * @returns A létrejött user publikus adatai.
   */
  @Post('register')
  public async register(@Body() dto : RegisterDto) : Promise<SafeUserResponse> {
    return await this.authService.register(dto);
  }

  /**
   * Email megerősítése token alapján.
   * @param token Megerősítő token.
   * @returns Sikerjelzés.
   */
  @Get('verify-email')
  public async verifyEmail(@Query('token') token : string) : Promise<{ success : boolean }> {
    return await this.authService.verifyEmail(token);
  }

  /**
   * Bejelentkezés.
   * @param dto Login adatok.
   * @returns JWT token.
   */
  @Post('login')
  public async login(@Body() dto : LoginDto) : Promise<AuthTokenResponse> {
    return await this.authService.login(dto);
  }

  /**
   * Elfelejtett jelszó folyamat indítása.
   * @param dto Email cím.
   * @returns Sikerjelzés.
   */
  @Post('forgot-password')
  public async forgotPassword(@Body() dto : ForgotPasswordDto) : Promise<{ success : boolean }> {
    return await this.authService.forgotPassword(dto);
  }

  /**
   * Jelszó visszaállítás tokennel.
   * @param dto Reset adatok.
   * @returns Sikerjelzés.
   */
  @Post('reset-password')
  public async resetPassword(@Body() dto : ResetPasswordDto) : Promise<{ success : boolean }> {
    return await this.authService.resetPassword(dto);
  }

  /**
   * Bejelentkezett felhasználó profilja.
   * @param user JWT-ből érkező user.
   * @returns Publikus profil.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  public async me(@CurrentUser() user : AuthUser) : Promise<SafeUserResponse> {
    return await this.authService.getProfile(user.id);
  }
}
