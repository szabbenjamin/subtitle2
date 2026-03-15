import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity({ name: 'videos' })
export class VideoEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column()
  public ownerId !: number;

  @ManyToOne(() => UserEntity, (user : UserEntity) => user.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ownerId' })
  public owner !: UserEntity;

  @Column()
  public originalFileName !: string;

  @Column()
  public storageFileName !: string;

  @Column({ type: 'integer' })
  public fileSizeBytes !: number;

  @Column({ type: 'integer', default: 0 })
  public durationSeconds !: number;

  @Column({ type: 'boolean', default: false })
  public isHidden !: boolean;

  @Column({ type: 'boolean', default: false })
  public listenRequested !: boolean;

  @Column({ type: 'text', default: '' })
  public subtitleText !: string;

  @Column({ type: 'text', default: 'pending' })
  public processingStatus !: string;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
