import { CanDeactivateFn } from '@angular/router';
import { ListPage } from '../pages/list/list.page';

/**
 * Lista oldal elhagyásának guardja aktív fájlfeltöltés esetén.
 */
export const listUploadLeaveGuard : CanDeactivateFn<ListPage> = (component : ListPage) => {
  if (component.hasBlockingFileUpload() === false) {
    return true;
  }

  return window.confirm('Fájlfeltöltés folyamatban. Ha elnavigálsz, a feltöltés megszakad. Biztosan folytatod?');
};

