import { Routes } from '@angular/router';
import { adminEmailGuard } from './guards/admin-email.guard';
import { authGuard } from './guards/auth.guard';
import { listUploadLeaveGuard } from './guards/list-upload-leave.guard';
import { AdminTokensPage } from './pages/admin-tokens/admin-tokens.page';
import { GuidePage } from './pages/guide/guide.page';
import { ListPage } from './pages/list/list.page';
import { LoginPage } from './pages/login/login.page';
import { TokensPage } from './pages/tokens/tokens.page';
import { VideoPage } from './pages/video/video.page';
import { VideoHighlightsPage } from './pages/video-highlights/video-highlights.page';

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
    canDeactivate: [listUploadLeaveGuard],
  },
  {
    path: 'video/:id',
    component: VideoPage,
    canActivate: [authGuard],
  },
  {
    path: 'video/:id/highlights',
    component: VideoHighlightsPage,
    canActivate: [authGuard],
  },
  {
    path: 'tokenek',
    component: TokensPage,
    canActivate: [authGuard],
  },
  {
    path: 'kezikonyv',
    component: GuidePage,
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
