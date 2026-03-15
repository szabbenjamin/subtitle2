import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VideoEntity } from '../../videos/entities/video.entity';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn()
  public id !: number;

  @Column({ unique: true })
  public email !: string;

  @Column()
  public passwordHash !: string;

  @Column({ default: false })
  public isEmailVerified !: boolean;

  @Column({ type: 'text', nullable: true })
  public emailVerificationToken ?: string | null;

  @Column({ type: 'text', nullable: true })
  public resetPasswordToken ?: string | null;

  @Column({ type: 'datetime', nullable: true })
  public resetPasswordExpiresAt ?: Date | null;

  @OneToMany(() => VideoEntity, (video : VideoEntity) => video.owner)
  public videos !: VideoEntity[];

  @CreateDateColumn()
  public createdAt !: Date;

  @UpdateDateColumn()
  public updatedAt !: Date;
}
