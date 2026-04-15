import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { SubtitlePresetEntity } from '../../subtitle-presets/entities/subtitle-preset.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { VideoHighlightAnalysisEntity } from './video-highlight-analysis.entity';
import { VideoHighlightClipEntity } from './video-highlight-clip.entity';

const bigIntNumberTransformer : ValueTransformer = {
  to: (value : number) => Math.max(0, Math.round(value)),
  from: (value : string | number | null) => {
    if (value === null) {
      return 0;
    }
    const parsed : number = Number(value);
    if (Number.isFinite(parsed) === false || parsed < 0) {
      return 0;
    }
    return Math.round(parsed);
  },
};

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

  @Column({ type: 'varchar', length: 255, default: '' })
  public thumbnailFileName !: string;

  @Column({
    type: 'bigint',
    unsigned: true,
    transformer: bigIntNumberTransformer,
  })
  public fileSizeBytes !: number;

  @Column({ type: 'integer', default: 0 })
  public durationSeconds !: number;

  @Column({ type: 'boolean', default: false })
  public isHidden !: boolean;

  @Column({ type: 'boolean', default: false })
  public listenRequested !: boolean;

  @Column({ type: 'longtext', default: () => "('')" })
  public subtitleText !: string;

  @Column({ type: 'varchar', length: 32, default: 'idle' })
  public processingStatus !: string;

  @Column({ type: 'longtext', default: () => "('')" })
  public socialTextCombined !: string;

  @Column({ type: 'integer', nullable: true })
  public subtitlePresetId ?: number | null;

  @ManyToOne(() => SubtitlePresetEntity, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'subtitlePresetId' })
  public subtitlePreset ?: SubtitlePresetEntity | null;

  @OneToMany(() => VideoHighlightAnalysisEntity, (analysis : VideoHighlightAnalysisEntity) => analysis.video)
  public highlightAnalyses !: VideoHighlightAnalysisEntity[];

  @OneToMany(() => VideoHighlightClipEntity, (clip : VideoHighlightClipEntity) => clip.video)
  public highlightClips !: VideoHighlightClipEntity[];

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
