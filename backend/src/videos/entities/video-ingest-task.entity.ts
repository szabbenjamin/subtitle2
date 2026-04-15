import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type VideoIngestSourceType = 'file' | 'youtube';
export type VideoIngestStatus = 'queued' | 'uploading' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled';

@Entity({ name: 'video_ingest_tasks' })
@Index(['ownerId', 'status'])
@Index(['ownerId', 'sourceType', 'externalId'], { unique: true })
export class VideoIngestTaskEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column()
  public ownerId !: number;

  @Column({ type: 'varchar', length: 16 })
  public sourceType !: VideoIngestSourceType;

  @Column({ type: 'varchar', length: 191 })
  public externalId !: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  public displayTitle !: string;

  @Column({ type: 'varchar', length: 32 })
  public status !: VideoIngestStatus;

  @Column({ type: 'integer', default: 0 })
  public progressPercent !: number;

  @Column({ type: 'varchar', length: 255, default: '' })
  public stageMessage !: string;

  @Column({ type: 'text', default: () => "('')" })
  public errorMessage !: string;

  @Column({ type: 'integer', nullable: true })
  public videoId !: number | null;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
