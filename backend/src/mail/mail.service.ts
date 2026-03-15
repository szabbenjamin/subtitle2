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
