import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity({ name: 'token_history' })
export class TokenHistoryEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column({ type: 'integer' })
  public userId !: number;

  @ManyToOne(() => UserEntity, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  public user !: UserEntity;

  @Column({ type: 'integer' })
  public delta !: number;

  @Column({ type: 'integer' })
  public balanceAfter !: number;

  @Column({ type: 'text' })
  public type !: string;

  @Column({ type: 'text' })
  public description !: string;

  @CreateDateColumn()
  public createdAt !: Date;
}
