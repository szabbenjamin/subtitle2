import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../common/interfaces/auth-user.interface';
import { SetUserBalanceDto } from './dto/set-user-balance.dto';
import { AdminUserTokenItem, TokenBalanceResponse, TokenHistoryItem, TokensService } from './tokens.service';

const ADMIN_EMAIL : string = 'szabbenjamin@gmail.com';

@Controller('tokens')
@UseGuards(JwtAuthGuard)
export class TokensController {
  public constructor(private readonly tokensService : TokensService) {}

  /**
   * Aktuális token egyenleg lekérése.
   */
  @Get('balance')
  public async balance(@CurrentUser() user : AuthUser) : Promise<TokenBalanceResponse> {
    return await this.tokensService.getBalance(user.id);
  }

  /**
   * Token history lista lekérése.
   */
  @Get('history')
  public async history(@CurrentUser() user : AuthUser) : Promise<TokenHistoryItem[]> {
    return await this.tokensService.getHistory(user.id);
  }

  /**
   * Admin endpoint: összes felhasználó token adat.
   */
  @Get('admin/users')
  public async listUsersForAdmin(@CurrentUser() user : AuthUser) : Promise<AdminUserTokenItem[]> {
    this.assertAdminEmail(user.email);
    return await this.tokensService.listUsersForAdmin();
  }

  /**
   * Admin endpoint: user token egyenleg beállítás.
   */
  @Patch('admin/users/:id/balance')
  public async setUserBalanceForAdmin(
    @CurrentUser() user : AuthUser,
    @Param('id', ParseIntPipe) id : number,
    @Body() dto : SetUserBalanceDto,
  ) : Promise<AdminUserTokenItem> {
    this.assertAdminEmail(user.email);
    return await this.tokensService.setUserBalanceByAdmin(id, dto.tokenBalance, user.email);
  }

  /**
   * Csak a dedikált admin email férhet hozzá.
   */
  private assertAdminEmail(email : string) : void {
    if (email.trim().toLowerCase() !== ADMIN_EMAIL) {
      throw new ForbiddenException('Nincs jogosultság ehhez a művelethez.');
    }
  }
}
