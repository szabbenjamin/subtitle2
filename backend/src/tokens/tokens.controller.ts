import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../common/interfaces/auth-user.interface';
import { TokenBalanceResponse, TokenHistoryItem, TokensService } from './tokens.service';

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
}
