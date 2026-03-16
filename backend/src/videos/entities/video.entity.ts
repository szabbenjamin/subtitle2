import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SubtitlePresetEntity } from '../../subtitle-presets/entities/subtitle-preset.entity';
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

  @Column({ type: 'text', default: 'medium' })
  public whisperModel !: string;

  @Column({ type: 'text', default: 'hu' })
  public whisperLanguage !: string;

  @Column({ type: 'integer', default: 7 })
  public wordsPerLine !: number;

  @Column({ type: 'text', default: 'idle' })
  public processingStatus !: string;

  @Column({ type: 'text', default: '' })
  public socialTextCombined !: string;

  @Column({ type: 'integer', nullable: true })
  public subtitlePresetId ?: number | null;

  @ManyToOne(() => SubtitlePresetEntity, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'subtitlePresetId' })
  public subtitlePreset ?: SubtitlePresetEntity | null;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
