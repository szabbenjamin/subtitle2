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
import { VideoEntity } from './video.entity';
import { VideoHighlightAnalysisEntity } from './video-highlight-analysis.entity';

@Entity({ name: 'video_highlight_clips' })
export class VideoHighlightClipEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column()
  public analysisId !: number;

  @ManyToOne(() => VideoHighlightAnalysisEntity, (analysis : VideoHighlightAnalysisEntity) => analysis.clips, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'analysisId' })
  public analysis !: VideoHighlightAnalysisEntity;

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

  @Column({ type: 'integer', default: 1 })
  public rank !: number;

  @Column({ type: 'float', default: 0 })
  public score !: number;

  @Column({ type: 'float', default: 0 })
  public startSeconds !: number;

  @Column({ type: 'float', default: 0 })
  public endSeconds !: number;

  @Column({ type: 'varchar', length: 255, default: '' })
  public screenshotFileName !: string;

  @Column({ type: 'text', default: () => "('')" })
  public transcriptSnippet !: string;

  @Column({ type: 'longtext', default: () => "('')" })
  public reasonsJson !: string;

  @Column({ type: 'varchar', length: 32, default: 'unset' })
  public feedbackStatus !: string;

  @Column({ type: 'text', default: () => "('')" })
  public feedbackNote !: string;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
