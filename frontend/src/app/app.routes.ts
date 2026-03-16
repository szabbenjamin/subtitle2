import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { ListPage } from './pages/list/list.page';
import { LoginPage } from './pages/login/login.page';
import { TokensPage } from './pages/tokens/tokens.page';
import { VideoPage } from './pages/video/video.page';

export const routes : Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'lista',
  },
  {
    path: 'login',
    component: LoginPage,
  },
  {
    path: 'login/reset',
    component: LoginPage,
    data: {
      resetOnly: true,
    },
  },
  {
    path: 'lista',
    component: ListPage,
    canActivate: [authGuard],
  },
  {
    path: 'video/:id',
    component: VideoPage,
    canActivate: [authGuard],
  },
  {
    path: 'tokenek',
    component: TokensPage,
    canActivate: [authGuard],
  },
  {
    path: '**',
    redirectTo: 'lista',
  },
];
