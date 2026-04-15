import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';
import { VideoEntity } from './video.entity';
import { VideoHighlightClipEntity } from './video-highlight-clip.entity';

@Entity({ name: 'video_highlight_analyses' })
export class VideoHighlightAnalysisEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column()
  public ownerId !: number;

  @ManyToOne(() => UserEntity, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ownerId' })
  public owner !: UserEntity;

  @Column()
  public videoId !: number;

  @ManyToOne(() => VideoEntity, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'videoId' })
  public video !: VideoEntity;

  @OneToMany(() => VideoHighlightClipEntity, (clip : VideoHighlightClipEntity) => clip.analysis)
  public clips !: VideoHighlightClipEntity[];

  @Column({ type: 'varchar', length: 32, default: 'balanced' })
  public mode !: string;

  @Column({ type: 'varchar', length: 32, default: 'queued' })
  public status !: string;

  @Column({ type: 'varchar', length: 32, default: 'queued' })
  public stageCode !: string;

  @Column({ type: 'varchar', length: 255, default: 'Várólistán...' })
  public stageMessage !: string;

  @Column({ type: 'integer', default: 0 })
  public progressPercent !: number;

  @Column({ type: 'boolean', default: false })
  public requiresWhisper !: boolean;

  @Column({ type: 'text', default: () => "('')" })
  public errorMessage !: string;

  @Column({ type: 'datetime', nullable: true })
  public startedAt ?: Date | null;

  @Column({ type: 'datetime', nullable: true })
  public completedAt ?: Date | null;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
