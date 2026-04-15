import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger : Logger = new Logger(MailService.name);
  private readonly transporter ?: Transporter;

  public constructor(private readonly configService : ConfigService) {
    const smtpUser : string | undefined = this.configService.get<string>('SMTP_USER');
    const smtpPass : string | undefined = this.configService.get<string>('SMTP_PASS');

    if (smtpUser !== undefined && smtpPass !== undefined && smtpUser.length > 0 && smtpPass.length > 0) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
    }
  }

  /**
   * Regisztráció megerősítő email küldése.
   * @param email Címzett email címe.
   * @param verifyUrl Megerősítő URL.
   * @returns Nem ad vissza értéket.
   */
  public async sendVerificationEmail(email : string, verifyUrl : string) : Promise<void> {
    await this.sendMail(
      email,
      'subtitle2 - Email megerősítés',
      `Kérlek erősítsd meg az email címedet ezen a linken: ${verifyUrl}`,
    );
  }

  /**
   * Jelszó-visszaállító email küldése.
   * @param email Címzett email címe.
   * @param resetUrl Jelszó-visszaállító URL.
   * @returns Nem ad vissza értéket.
   */
  public async sendPasswordResetEmail(email : string, resetUrl : string) : Promise<void> {
    await this.sendMail(
      email,
      'subtitle2 - Jelszó visszaállítás',
      `A jelszó visszaállításához nyisd meg ezt a linket: ${resetUrl}`,
    );
  }

  /**
   * Napi emlékeztető küldése az 1 hónapnál régebbi videókról.
   * @param email Címzett email címe.
   * @param oldVideoCount Régi videók darabszáma.
   * @param chargedToday Ma levont token mennyiség.
   * @param unchargedToday Ma fel nem számolt régi videók száma (pl. nincs elég token).
   * @returns Nem ad vissza értéket.
   */
  public async sendOldVideoStorageReminderEmail(params : {
    email : string;
    oldVideoCount : number;
    chargedToday : number;
    unchargedToday : number;
  }) : Promise<void> {
    const chargedLine : string =
      params.chargedToday > 0
        ? `A mai napi régi-videó tárolási díj levonása: ${params.chargedToday} token.`
        : 'A mai napi régi-videó tárolási díjból most nem történt levonás.';
    const unchargedLine : string =
      params.unchargedToday > 0
        ? `További ${params.unchargedToday} régi videóra ma már nem tudtunk tokent levonni.`
        : 'Minden érintett régi videóra megtörtént a mai napi levonás.';

    await this.sendMail(
      params.email,
      'subtitle2 - Régi videók napi token díja',
      [
        `Jelenleg ${params.oldVideoCount} darab, 1 hónapnál régebbi videód van fenn a rendszerben.`,
        chargedLine,
        unchargedLine,
        'Ha ezt nem szeretnéd, töröld a régi videókat a listaoldalon.',
      ].join('\n'),
    );
  }

  /**
   * Alacsony szintű emailküldés közös metódusa.
   * @param email Címzett.
   * @param subject Tárgy.
   * @param text Törzs.
   * @returns Nem ad vissza értéket.
   */
  private async sendMail(email : string, subject : string, text : string) : Promise<void> {
    if (this.transporter === undefined) {
      this.logger.warn(`SMTP nincs beállítva, email nem került kiküldésre: ${subject} -> ${email}`);
      return;
    }

    const fromAddress : string = this.configService.get<string>('SMTP_FROM') ?? 'subtitle2 <noreply@subtitle2.winben.hu>';
    await this.transporter.sendMail({
      from: fromAddress,
      to: email,
      subject,
      text,
    });
  }
}
