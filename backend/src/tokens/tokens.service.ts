import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { TokenHistoryEntity } from './entities/token-history.entity';
import {
  MONTHLY_BONUS_LIMIT,
  MONTHLY_BONUS_TOKENS,
  TOKEN_ENTRY_TYPE_MONTHLY,
} from './tokens.constants';

export interface TokenBalanceResponse {
  tokenBalance : number;
}

export interface TokenHistoryItem {
  id : number;
  delta : number;
  balanceAfter : number;
  type : string;
  description : string;
  createdAt : Date;
}

@Injectable()
export class TokensService {
  public constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository : Repository<UserEntity>,
    @InjectRepository(TokenHistoryEntity)
    private readonly tokenHistoryRepository : Repository<TokenHistoryEntity>,
  ) {}

  /**
   * Aktuális token egyenleg lekérése havi jóváírás ellenőrzéssel.
   */
  public async getBalance(userId : number) : Promise<TokenBalanceResponse> {
    const user : UserEntity = await this.ensureMonthlyTopupIfNeeded(userId);
    return { tokenBalance: user.tokenBalance };
  }

  /**
   * Token history lekérése csökkenő dátum szerint.
   */
  public async getHistory(userId : number) : Promise<TokenHistoryItem[]> {
    await this.ensureMonthlyTopupIfNeeded(userId);
    const rows : TokenHistoryEntity[] = await this.tokenHistoryRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 250,
    });

    return rows.map((row : TokenHistoryEntity) => ({
      id: row.id,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      type: row.type,
      description: row.description,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Token jóváírás és history bejegyzés.
   */
  public async credit(userId : number, amount : number, type : string, description : string) : Promise<number> {
    if (amount <= 0) {
      throw new BadRequestException('A jóváírandó token mennyiség legyen pozitív.');
    }

    const user : UserEntity = await this.requireUser(userId);
    user.tokenBalance += amount;
    const savedUser : UserEntity = await this.usersRepository.save(user);

    await this.createHistoryEntry(savedUser.id, amount, savedUser.tokenBalance, type, description);
    return savedUser.tokenBalance;
  }

  /**
   * Token levonás és history bejegyzés.
   */
  public async charge(userId : number, amount : number, type : string, description : string) : Promise<number> {
    if (amount <= 0) {
      throw new BadRequestException('A levonandó token mennyiség legyen pozitív.');
    }

    const user : UserEntity = await this.ensureMonthlyTopupIfNeeded(userId);
    if (user.tokenBalance < amount) {
      throw new BadRequestException(
        `Nincs elegendő tokened a művelethez. Szükséges: ${amount}, jelenlegi: ${user.tokenBalance}. ` +
          'Kérlek, vedd fel a kapcsolatot a szoftver üzemeltetőjével.',
      );
    }

    user.tokenBalance -= amount;
    const savedUser : UserEntity = await this.usersRepository.save(user);
    await this.createHistoryEntry(savedUser.id, -amount, savedUser.tokenBalance, type, description);

    return savedUser.tokenBalance;
  }

  /**
   * Havi +100 token jóváírás (havi egyszer), ha egyenleg 300 alatt van.
   */
  public async ensureMonthlyTopupIfNeeded(userId : number) : Promise<UserEntity> {
    const user : UserEntity = await this.requireUser(userId);
    const currentMonthKey : string = this.getCurrentMonthKey();

    if (user.lastTokenTopupMonth === currentMonthKey) {
      return user;
    }

    if (user.tokenBalance < MONTHLY_BONUS_LIMIT) {
      user.tokenBalance += MONTHLY_BONUS_TOKENS;
      user.lastTokenTopupMonth = currentMonthKey;
      const savedUser : UserEntity = await this.usersRepository.save(user);

      await this.createHistoryEntry(
        savedUser.id,
        MONTHLY_BONUS_TOKENS,
        savedUser.tokenBalance,
        TOKEN_ENTRY_TYPE_MONTHLY,
        'Havi token jóváírás',
      );

      return savedUser;
    }

    user.lastTokenTopupMonth = currentMonthKey;
    return await this.usersRepository.save(user);
  }

  /**
   * Felhasználó betöltése vagy 404.
   */
  private async requireUser(userId : number) : Promise<UserEntity> {
    const user : UserEntity | null = await this.usersRepository.findOne({ where: { id: userId } });
    if (user === null) {
      throw new NotFoundException('A felhasználó nem található.');
    }
    return user;
  }

  /**
   * Token history sor mentése.
   */
  private async createHistoryEntry(
    userId : number,
    delta : number,
    balanceAfter : number,
    type : string,
    description : string,
  ) : Promise<void> {
    const row : TokenHistoryEntity = this.tokenHistoryRepository.create({
      userId,
      delta,
      balanceAfter,
      type,
      description,
    });

    await this.tokenHistoryRepository.save(row);
  }

  /**
   * Aktuális hónap kulcs: YYYY-MM.
   */
  private getCurrentMonthKey() : string {
    const now : Date = new Date();
    const year : number = now.getUTCFullYear();
    const month : string = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
