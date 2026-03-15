import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit } from '@angular/core';
import { AbstractControl, FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize } from 'rxjs';
import { AuthService } from '../../services/auth.service';

type LoginModal = 'none' | 'login' | 'register' | 'forgot' | 'reset';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './login.page.html',
  styleUrl: './login.page.scss',
})
export class LoginPage implements OnInit {
  public readonly loginForm : FormGroup;
  public readonly registerForm : FormGroup;
  public readonly forgotForm : FormGroup;
  public readonly resetForm : FormGroup;
  public message : string = '';
  public errorMessage : string = '';
  public infoMessage : string = '';
  public activeModal : LoginModal = 'none';
  public isResetOnlyRoute : boolean = false;
  private readonly flashMessageKey : string = 'subtitle2_flash_message';

  public constructor(
    private readonly formBuilder : FormBuilder,
    private readonly authService : AuthService,
    private readonly router : Router,
    private readonly activatedRoute : ActivatedRoute,
  ) {
    this.loginForm = this.formBuilder.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(8)]],
    });

    this.registerForm = this.formBuilder.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(8)]],
    });

    this.forgotForm = this.formBuilder.group({
      email: ['', [Validators.required, Validators.email]],
    });

    this.resetForm = this.formBuilder.group({
      token: ['', [Validators.required]],
      newPassword: ['', [Validators.required, Validators.minLength(8)]],
    });
  }

  /**
   * Query param alapú auth műveletek futtatása és modal állapot beállítása.
   * @returns Nem ad vissza értéket.
   */
  public ngOnInit() : void {
    this.isResetOnlyRoute = this.activatedRoute.snapshot.data['resetOnly'] === true;

    const verifyToken : string | null = this.activatedRoute.snapshot.queryParamMap.get('verifyToken');
    const resetToken : string | null = this.activatedRoute.snapshot.queryParamMap.get('resetToken');

    this.consumeFlashMessage();

    if (verifyToken !== null && verifyToken.length > 0) {
      const pendingText : string = 'Email megerősítés folyamatban...';
      this.setInfo(pendingText);
      this.authService
        .verifyEmail(verifyToken)
        .pipe(
          finalize(() : void => {
            if (this.infoMessage === pendingText) {
              this.infoMessage = '';
            }
            void this.router.navigate([], {
              relativeTo: this.activatedRoute,
              queryParams: { verifyToken: null },
              queryParamsHandling: 'merge',
              replaceUrl: true,
            });
          }),
        )
        .subscribe({
          next: () => {
            this.setSuccess('Email cím sikeresen megerősítve.');
          },
          error: (error : unknown) => {
            this.handleError(error, 'Az email megerősítés sikertelen.');
          },
        });
    }

    if (this.isResetOnlyRoute === true) {
      const validResetToken : boolean = resetToken !== null && resetToken.length > 0;
      if (validResetToken === false) {
        this.errorMessage = 'Érvénytelen vagy hiányzó reset link.';
        void this.router.navigate(['/login']);
        return;
      }

      this.resetForm.patchValue({ token: resetToken });
      this.activeModal = 'reset';
    }
  }

  /**
   * Modal megnyitása.
   * @param modal Megnyitandó modal.
   * @returns Nem ad vissza értéket.
   */
  public openModal(modal : LoginModal) : void {
    if (modal === 'reset') {
      return;
    }

    this.activeModal = modal;
    this.errorMessage = '';
    this.message = '';
    this.infoMessage = '';
  }

  /**
   * Modal bezárása.
   * @returns Nem ad vissza értéket.
   */
  public closeModal() : void {
    if (this.isResetOnlyRoute === true) {
      void this.router.navigate(['/login']);
      return;
    }

    this.activeModal = 'none';
    this.errorMessage = '';
    this.infoMessage = '';
  }

  /**
   * Háttérre kattintásra bezárja a modalt.
   * @param event Kattintási esemény.
   * @returns Nem ad vissza értéket.
   */
  public onBackdropClick(event : MouseEvent) : void {
    const target : EventTarget | null = event.target;
    const currentTarget : EventTarget | null = event.currentTarget;

    if (target === currentTarget) {
      this.closeModal();
    }
  }

  /**
   * Bejelentkezés végrehajtása.
   * @returns Nem ad vissza értéket.
   */
  public submitLogin() : void {
    this.clearMessages();
    const invalidForm : boolean = this.loginForm.invalid;
    if (invalidForm === true) {
      this.loginForm.markAllAsTouched();
      return;
    }

    const email : string = String(this.loginForm.value.email ?? '');
    const password : string = String(this.loginForm.value.password ?? '');

    this.setInfo('Bejelentkezés folyamatban...');
    this.authService.login(email, password).subscribe({
      next: () => {
        this.setSuccess('Sikeres bejelentkezés, átirányítás...');
        void this.router.navigate(['/lista']);
      },
      error: (error : unknown) => {
        this.handleError(error, 'Bejelentkezési hiba.');
      },
    });
  }

  /**
   * Regisztráció beküldése.
   * @returns Nem ad vissza értéket.
   */
  public submitRegister() : void {
    this.clearMessages();
    const invalidForm : boolean = this.registerForm.invalid;
    if (invalidForm === true) {
      this.registerForm.markAllAsTouched();
      return;
    }

    const email : string = String(this.registerForm.value.email ?? '');
    const password : string = String(this.registerForm.value.password ?? '');

    this.setInfo('Regisztráció küldése...');
    this.authService.register(email, password).subscribe({
      next: () => {
        this.setSuccess('Sikeres regisztráció. Megerősítő email elküldve.');
        this.activeModal = 'login';
        this.loginForm.patchValue({ email });
      },
      error: (error : unknown) => {
        this.handleError(error, 'Regisztrációs hiba.');
      },
    });
  }

  /**
   * Elfelejtett jelszó kérés beküldése.
   * @returns Nem ad vissza értéket.
   */
  public submitForgot() : void {
    this.clearMessages();
    const invalidForm : boolean = this.forgotForm.invalid;
    if (invalidForm === true) {
      this.forgotForm.markAllAsTouched();
      return;
    }

    const email : string = String(this.forgotForm.value.email ?? '');
    this.setInfo('Reset email küldése...');
    this.authService.forgotPassword(email).subscribe({
      next: () => {
        this.setSuccess('Ha létezik a fiók, a jelszó-visszaállító email elküldésre került.');
      },
      error: (error : unknown) => {
        this.handleError(error, 'Nem sikerült elindítani a jelszó-visszaállítást.');
      },
    });
  }

  /**
   * Új jelszó mentése reset token alapján.
   * @returns Nem ad vissza értéket.
   */
  public submitReset() : void {
    this.clearMessages();
    const invalidForm : boolean = this.resetForm.invalid;
    if (invalidForm === true) {
      this.resetForm.markAllAsTouched();
      return;
    }

    const token : string = String(this.resetForm.value.token ?? '');
    const newPassword : string = String(this.resetForm.value.newPassword ?? '');

    this.setInfo('Új jelszó mentése...');
    this.authService.resetPassword(token, newPassword).subscribe({
      next: () => {
        const successMessage : string = 'A jelszó sikeresen módosítva. Most már be tudsz jelentkezni.';
        this.saveFlashMessage(successMessage);
        void this.router.navigate(['/login']);
      },
      error: (error : unknown) => {
        this.handleError(error, 'A jelszó visszaállítás sikertelen.');
      },
    });
  }

  /**
   * Egységes API hiba kezelés: kiírás + alert fallback.
   * @param error Hibaobjektum.
   * @param fallback Alapértelmezett hibaüzenet.
   * @returns Nem ad vissza értéket.
   */
  private handleError(error : unknown, fallback : string) : void {
    this.message = '';
    this.infoMessage = '';
    this.errorMessage = this.extractErrorMessage(error, fallback);

    if (this.errorMessage.length > 0) {
      window.alert(this.errorMessage);
    }
  }

  /**
   * Siker üzenet beállítása.
   * @param text Sikeres művelet üzenete.
   * @returns Nem ad vissza értéket.
   */
  private setSuccess(text : string) : void {
    this.message = text;
    this.errorMessage = '';
    this.infoMessage = '';
  }

  /**
   * Folyamat közbeni információs üzenet beállítása.
   * @param text Információs üzenet.
   * @returns Nem ad vissza értéket.
   */
  private setInfo(text : string) : void {
    this.infoMessage = text;
    this.errorMessage = '';
    this.message = '';
  }

  /**
   * Üzenetek törlése.
   * @returns Nem ad vissza értéket.
   */
  private clearMessages() : void {
    this.message = '';
    this.errorMessage = '';
    this.infoMessage = '';
  }

  /**
   * Flash üzenet mentése route váltásra.
   * @param text Mentendő üzenet.
   * @returns Nem ad vissza értéket.
   */
  private saveFlashMessage(text : string) : void {
    localStorage.setItem(this.flashMessageKey, text);
  }

  /**
   * Flash üzenet kiolvasása és törlése.
   * @returns Nem ad vissza értéket.
   */
  private consumeFlashMessage() : void {
    const flashMessage : string | null = localStorage.getItem(this.flashMessageKey);
    if (flashMessage !== null && flashMessage.length > 0) {
      this.setSuccess(flashMessage);
      localStorage.removeItem(this.flashMessageKey);
    }
  }

  /**
   * API hibából felhasználóbarát üzenetet állít elő.
   * @param error Tetszőleges hibaobjektum.
   * @param fallback Alapértelmezett üzenet.
   * @returns Megjeleníthető hibaüzenet.
   */
  private extractErrorMessage(error : unknown, fallback : string) : string {
    if (error instanceof HttpErrorResponse) {
      const parsedMessage : string | null = this.parseMessageFromPayload(error.error);
      if (parsedMessage !== null) {
        return parsedMessage;
      }

      const hasStatus : boolean = Number.isFinite(error.status) && error.status > 0;
      if (hasStatus === true) {
        return `${fallback} (HTTP ${error.status})`;
      }
    }

    return fallback;
  }

  /**
   * Rekurzívan megpróbál olvasható hibaüzenetet kinyerni tetszőleges payloadból.
   * @param payload HTTP hiba payload.
   * @returns Üzenet vagy null, ha nem található.
   */
  private parseMessageFromPayload(payload : unknown) : string | null {
    if (typeof payload === 'string' && payload.length > 0) {
      const trimmedPayload : string = payload.trim();
      const looksLikeJson : boolean =
        (trimmedPayload.startsWith('{') && trimmedPayload.endsWith('}')) ||
        (trimmedPayload.startsWith('[') && trimmedPayload.endsWith(']'));

      if (looksLikeJson === true) {
        try {
          const parsedJson : unknown = JSON.parse(trimmedPayload);
          return this.parseMessageFromPayload(parsedJson);
        } catch {
          return payload;
        }
      }

      return payload;
    }

    if (Array.isArray(payload) && payload.length > 0) {
      const items : string[] = payload
        .map((item : unknown) => this.parseMessageFromPayload(item))
        .filter((item : string | null) : item is string => item !== null && item.length > 0);
      if (items.length > 0) {
        return items.join(', ');
      }
    }

    if (typeof payload === 'object' && payload !== null) {
      const payloadRecord : Record<string, unknown> = payload as Record<string, unknown>;

      const directMessage : string | null = this.parseMessageFromPayload(payloadRecord['message']);
      if (directMessage !== null) {
        return directMessage;
      }

      const nestedError : string | null = this.parseMessageFromPayload(payloadRecord['error']);
      if (nestedError !== null) {
        return nestedError;
      }
    }

    return null;
  }

  /**
   * Eldönti, hogy egy adott mező hibás és látható-e a hibaállapot.
   * @param form Ellenőrzendő form.
   * @param controlName Form control neve.
   * @returns Igaz, ha meg kell jeleníteni a hibát.
   */
  public isControlInvalid(form : FormGroup, controlName : string) : boolean {
    const control : AbstractControl<unknown, unknown> | null = form.get(controlName);
    if (control === null) {
      return false;
    }

    return control.invalid && control.touched;
  }

  /**
   * Felhasználóbarát validációs üzenetet ad vissza egy mezőhöz.
   * @param form Ellenőrzendő form.
   * @param controlName Form control neve.
   * @returns Validációs üzenet vagy üres szöveg.
   */
  public getControlError(form : FormGroup, controlName : string) : string {
    const control : AbstractControl<unknown, unknown> | null = form.get(controlName);
    if (control === null || control.errors === null) {
      return '';
    }

    const hasRequired : boolean = control.errors['required'] === true;
    if (hasRequired === true) {
      return 'A mező kitöltése kötelező.';
    }

    const hasEmail : boolean = control.errors['email'] === true;
    if (hasEmail === true) {
      return 'Érvényes email címet adj meg.';
    }

    const minLengthValue : { requiredLength : number } | undefined = control.errors['minlength'] as { requiredLength : number } | undefined;
    if (minLengthValue !== undefined) {
      return `Minimum ${minLengthValue.requiredLength} karakter szükséges.`;
    }

    return 'Érvénytelen érték.';
  }
}
