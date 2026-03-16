import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import {
  REGISTRATION_BONUS_TOKENS,
  TOKEN_ENTRY_TYPE_REGISTRATION,
} from '../tokens/tokens.constants';
import { TokensService } from '../tokens/tokens.service';
import { UserEntity } from '../users/entities/user.entity';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

export interface AuthTokenResponse {
  accessToken : string;
}

export interface SafeUserResponse {
  id : number;
  email : string;
  isEmailVerified : boolean;
  tokenBalance : number;
  createdAt : Date;
}

@Injectable()
export class AuthService {
  public constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository : Repository<UserEntity>,
    private readonly jwtService : JwtService,
    private readonly mailService : MailService,
    private readonly configService : ConfigService,
    private readonly tokensService : TokensService,
  ) {}

  /**
   * Új felhasználót regisztrál és megerősítő emailt küld.
   * @param dto Regisztrációs adatok.
   * @returns A létrejött felhasználó publikus adatai.
   */
  public async register(dto : RegisterDto) : Promise<SafeUserResponse> {
    const normalizedEmail : string = dto.email.toLowerCase().trim();
    const existingUser : UserEntity | null = await this.usersRepository.findOne({
      where: { email: normalizedEmail },
    });

    if (existingUser !== null) {
      throw new BadRequestException('Ez az email cím már regisztrálva van.');
    }

    const passwordHash : string = await bcrypt.hash(dto.password, 12);
    const verificationToken : string = randomBytes(24).toString('hex');

    const createdUser : UserEntity = this.usersRepository.create({
      email: normalizedEmail,
      passwordHash,
      isEmailVerified: false,
      emailVerificationToken: verificationToken,
      lastTokenTopupMonth: this.getCurrentMonthKey(),
    });

    const savedUser : UserEntity = await this.usersRepository.save(createdUser);
    const tokenBalance : number = await this.tokensService.credit(
      savedUser.id,
      REGISTRATION_BONUS_TOKENS,
      TOKEN_ENTRY_TYPE_REGISTRATION,
      'Regisztrációs kezdő token jóváírás',
    );
    savedUser.tokenBalance = tokenBalance;
    const frontendUrl : string = this.configService.get<string>('FRONTEND_BASE_URL') ?? 'https://subtitle2.winben.hu';
    const verifyUrl : string = `${frontendUrl}/login?verifyToken=${verificationToken}`;
    await this.mailService.sendVerificationEmail(savedUser.email, verifyUrl);

    return this.toSafeUser(savedUser);
  }

  /**
   * Email cím megerősítése token alapján.
   * @param token Megerősítő token.
   * @returns Visszaadja, hogy sikerült-e a megerősítés.
   */
  public async verifyEmail(token : string) : Promise<{ success : boolean }> {
    const user : UserEntity | null = await this.usersRepository.findOne({
      where: { emailVerificationToken: token },
    });

    if (user === null) {
      throw new BadRequestException('Érvénytelen megerősítő token.');
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    await this.usersRepository.save(user);

    return { success: true };
  }

  /**
   * Bejelentkezteti a felhasználót.
   * @param dto Bejelentkezési adatok.
   * @returns JWT access token.
   */
  public async login(dto : LoginDto) : Promise<AuthTokenResponse> {
    const normalizedEmail : string = dto.email.toLowerCase().trim();
    const user : UserEntity | null = await this.usersRepository.findOne({
      where: { email: normalizedEmail },
    });

    if (user === null) {
      throw new UnauthorizedException('Hibás email vagy jelszó.');
    }

    const passwordOk : boolean = await bcrypt.compare(dto.password, user.passwordHash);
    if (passwordOk === false) {
      throw new UnauthorizedException('Hibás email vagy jelszó.');
    }

    if (user.isEmailVerified === false) {
      throw new UnauthorizedException('Email cím megerősítése szükséges.');
    }

    const accessToken : string = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });

    return { accessToken };
  }

  /**
   * Elindítja a jelszó-emlékeztető folyamatot.
   * @param dto Email cím.
   * @returns Minden esetben sikeres jelzés.
   */
  public async forgotPassword(dto : ForgotPasswordDto) : Promise<{ success : boolean }> {
    const normalizedEmail : string = dto.email.toLowerCase().trim();
    const user : UserEntity | null = await this.usersRepository.findOne({
      where: { email: normalizedEmail },
    });

    if (user === null) {
      return { success: true };
    }

    const token : string = randomBytes(24).toString('hex');
    const expiresAt : Date = new Date(Date.now() + 1000 * 60 * 60);
    user.resetPasswordToken = token;
    user.resetPasswordExpiresAt = expiresAt;
    await this.usersRepository.save(user);

    const frontendUrl : string = this.configService.get<string>('FRONTEND_BASE_URL') ?? 'https://subtitle2.winben.hu';
    const resetUrl : string = `${frontendUrl}/login/reset?resetToken=${token}`;
    await this.mailService.sendPasswordResetEmail(user.email, resetUrl);

    return { success: true };
  }

  /**
   * Jelszó visszaállítása token alapján.
   * @param dto Új jelszó és token.
   * @returns Sikerjelzés.
   */
  public async resetPassword(dto : ResetPasswordDto) : Promise<{ success : boolean }> {
    const user : UserEntity | null = await this.usersRepository.findOne({
      where: { resetPasswordToken: dto.token },
    });

    if (user === null) {
      throw new BadRequestException('Érvénytelen reset token.');
    }

    if (user.resetPasswordExpiresAt === null || user.resetPasswordExpiresAt === undefined) {
      throw new BadRequestException('Lejárt reset token.');
    }

    if (user.resetPasswordExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Lejárt reset token.');
    }

    user.passwordHash = await bcrypt.hash(dto.newPassword, 12);
    user.resetPasswordToken = null;
    user.resetPasswordExpiresAt = null;
    await this.usersRepository.save(user);

    return { success: true };
  }

  /**
   * Visszaadja a felhasználó publikus profilját.
   * @param userId Felhasználó azonosító.
   * @returns Publikus profil.
   */
  public async getProfile(userId : number) : Promise<SafeUserResponse> {
    const user : UserEntity | null = await this.usersRepository.findOne({ where: { id: userId } });
    if (user === null) {
      throw new UnauthorizedException('A felhasználó nem található.');
    }

    const tokenBalance : number = (await this.tokensService.getBalance(userId)).tokenBalance;
    user.tokenBalance = tokenBalance;

    return this.toSafeUser(user);
  }

  /**
   * Belső átalakító publikus user DTO-ra.
   * @param user Teljes user entitás.
   * @returns Publikus user objektum.
   */
  private toSafeUser(user : UserEntity) : SafeUserResponse {
    return {
      id: user.id,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      tokenBalance: user.tokenBalance,
      createdAt: user.createdAt,
    };
  }

  /**
   * Aktuális hónap kulcs: YYYY-MM.
   */
  private getCurrentMonthKey() : string {
    const now : Date = new Date();
    const year : number = now.getUTCFullYear();
    const month : string = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
