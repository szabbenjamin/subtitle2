import { Injectable, WritableSignal, signal } from '@angular/core';

export interface AlertModalState {
  isOpen : boolean;
  title : string;
  message : string;
}

@Injectable({ providedIn: 'root' })
export class AlertModalService {
  public readonly state : WritableSignal<AlertModalState> = signal<AlertModalState>({
    isOpen: false,
    title: 'Hiba',
    message: '',
  });

  /**
   * Általános alert modal megnyitása.
   */
  public open(message : string, title : string = 'Hiba') : void {
    this.state.set({
      isOpen: true,
      title,
      message,
    });
  }

  /**
   * Alert modal bezárása.
   */
  public close() : void {
    this.state.set({
      isOpen: false,
      title: 'Hiba',
      message: '',
    });
  }
}
