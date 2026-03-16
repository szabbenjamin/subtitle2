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

@Entity({ name: 'subtitle_presets' })
export class SubtitlePresetEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column()
  public ownerId !: number;

  @ManyToOne(() => UserEntity, (user : UserEntity) => user.subtitlePresets, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ownerId' })
  public owner !: UserEntity;

  @Column({ type: 'text' })
  public name !: string;

  @Column({ type: 'text', default: 'Arial' })
  public fontName !: string;

  @Column({ type: 'integer', default: 56 })
  public fontSize !: number;

  @Column({ type: 'text', default: '#FFFFFF' })
  public primaryColour !: string;

  @Column({ type: 'text', default: '#000000' })
  public secondaryColour !: string;

  @Column({ type: 'text', default: '#000000' })
  public outlineColour !: string;

  @Column({ type: 'text', default: '#000000' })
  public backColour !: string;

  @Column({ type: 'boolean', default: false })
  public bold !: boolean;

  @Column({ type: 'boolean', default: false })
  public italic !: boolean;

  @Column({ type: 'boolean', default: false })
  public underline !: boolean;

  @Column({ type: 'boolean', default: false })
  public strikeOut !: boolean;

  @Column({ type: 'integer', default: 100 })
  public scaleX !: number;

  @Column({ type: 'integer', default: 100 })
  public scaleY !: number;

  @Column({ type: 'integer', default: 0 })
  public spacing !: number;

  @Column({ type: 'integer', default: 0 })
  public angle !: number;

  @Column({ type: 'integer', default: 1 })
  public borderStyle !: number;

  @Column({ type: 'integer', default: 2 })
  public outline !: number;

  @Column({ type: 'integer', default: 2 })
  public shadow !: number;

  @Column({ type: 'integer', default: 2 })
  public alignment !: number;

  @Column({ type: 'integer', default: 30 })
  public marginL !: number;

  @Column({ type: 'integer', default: 30 })
  public marginR !: number;

  @Column({ type: 'integer', default: 30 })
  public marginV !: number;

  @Column({ type: 'text', default: 'UTF-8' })
  public encoding !: string;

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
