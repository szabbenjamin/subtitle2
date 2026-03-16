import { Routes } from '@angular/router';
import { adminEmailGuard } from './guards/admin-email.guard';
import { authGuard } from './guards/auth.guard';
import { AdminTokensPage } from './pages/admin-tokens/admin-tokens.page';
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
    path: 'admin/tokenek',
    component: AdminTokensPage,
    canActivate: [authGuard, adminEmailGuard],
  },
  {
    path: '**',
    redirectTo: 'lista',
  },
];
